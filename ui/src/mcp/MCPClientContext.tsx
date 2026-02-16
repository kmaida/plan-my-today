import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { useAuth } from '../auth'
import { setMCPCallTool } from '../api/client'

// ── Types ──────────────────────────────────────────────────────────────────────

/** The result returned by callTool — content array with text/image/resource items. */
export type ToolCallResult = Awaited<ReturnType<Client['callTool']>>

interface MCPClientContextValue {
  /** Whether the MCP client is connected and ready to call tools. */
  isConnected: boolean
  /** Connection error, if any. */
  error: string | null
  /** Whether the connection has been lost (transport error detected). */
  connectionLost: boolean
  /** Manually trigger a full reconnection (teardown + reconnect). */
  reconnect: () => void
  /** Call an MCP tool by name. */
  callTool: (name: string, args?: Record<string, unknown>) => Promise<ToolCallResult>
  /** List all available tools from the MCP server. */
  listTools: () => Promise<Tool[]>
  /** Cached tool list (populated after first listTools call or on connect). */
  tools: Tool[]
}

const MCPClientContext = createContext<MCPClientContextValue | null>(null)

export function useMCP(): MCPClientContextValue {
  const ctx = useContext(MCPClientContext)
  if (!ctx) throw new Error('useMCP must be used within an MCPClientProvider')
  return ctx
}

// ── Provider ───────────────────────────────────────────────────────────────────

const MCP_URL = `${window.location.origin}/mcp`

export function MCPClientProvider({ children }: { children: ReactNode }) {
  const { token, isAuthenticated } = useAuth()
  const [isConnected, setIsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectionLost, setConnectionLost] = useState(false)
  const [tools, setTools] = useState<Tool[]>([])

  // Refs to hold the current client/transport (avoids stale closures)
  const clientRef = useRef<Client | null>(null)
  const transportRef = useRef<StreamableHTTPClientTransport | null>(null)
  /** True when disconnect is intentional (logout, unmount, token change). */
  const isDisconnectingRef = useRef(false)
  /** Stash the token so event handlers can access it without stale closures. */
  const tokenRef = useRef(token)
  tokenRef.current = token

  // ── Connect / disconnect based on auth state ────────────────────────────────

  useEffect(() => {
    if (!isAuthenticated || !token) {
      isDisconnectingRef.current = true
      disconnect()
      return
    }

    connect(token).catch(() => {
      // Initial connect failure is already handled inside connect()
      // (sets error state, logs). Catch here to avoid unhandled rejection.
    })

    return () => {
      isDisconnectingRef.current = true
      disconnect()
    }
  }, [isAuthenticated, token]) // eslint-disable-line react-hooks/exhaustive-deps

  async function connect(accessToken: string) {
    // Disconnect any existing connection first
    isDisconnectingRef.current = true
    await disconnect()
    isDisconnectingRef.current = false

    try {
      setError(null)
      setConnectionLost(false)

      const transport = new StreamableHTTPClientTransport(
        new URL(MCP_URL),
        {
          requestInit: {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
            },
          },
        },
      )

      const client = new Client(
        { name: 'todo-dashboard', version: '1.0.0' },
      )

      // The SDK uses Streamable HTTP (not WebSockets). When the server dies,
      // the SSE stream errors — firing onerror, not onclose. The SDK has
      // built-in SSE reconnection with backoff, so we don't need our own
      // retry loop. We just track the error state for the UI banner.
      transport.onerror = (err) => {
        console.error('[MCP] Transport error:', err)
        if (!isDisconnectingRef.current) {
          setError(err.message)
          setConnectionLost(true)
        }
      }

      transport.onclose = () => {
        console.log('[MCP] Transport closed')
        setIsConnected(false)
      }

      await client.connect(transport)

      clientRef.current = client
      transportRef.current = transport
      setIsConnected(true)
      setConnectionLost(false)

      // Wire the MCP callTool into the API client module
      setMCPCallTool(async (name, args = {}) => client.callTool({ name, arguments: args }))

      console.log('[MCP] Connected, session:', transport.sessionId)

      // Fetch tool list on connect
      try {
        const result = await client.listTools()
        setTools(result.tools)
        console.log(`[MCP] Discovered ${result.tools.length} tools`)
      } catch (err) {
        console.warn('[MCP] Failed to list tools on connect:', err)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to connect to MCP server'
      console.error('[MCP] Connection failed:', err)
      setError(msg)
      setIsConnected(false)
      throw err
    }
  }

  async function disconnect() {
    const client = clientRef.current
    const transport = transportRef.current

    clientRef.current = null
    transportRef.current = null
    setIsConnected(false)
    setTools([])
    setMCPCallTool(null)

    try {
      if (client) await client.close()
    } catch {
      // Ignore close errors
    }
    try {
      if (transport) await transport.close()
    } catch {
      // Ignore close errors
    }
  }

  /** Manual reconnect — full teardown + fresh connection. */
  const manualReconnect = useCallback(() => {
    const currentToken = tokenRef.current
    if (!currentToken) return
    setError(null)
    setConnectionLost(false)
    connect(currentToken).catch(() => {
      // Failure handled inside connect()
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Tool operations ─────────────────────────────────────────────────────────

  const callTool = useCallback(
    async (name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> => {
      const client = clientRef.current
      if (!client) throw new Error('MCP client not connected')
      const result = await client.callTool({ name, arguments: args })
      // Successful tool call means connection is alive — clear any stale error state
      if (connectionLost) {
        setConnectionLost(false)
        setError(null)
      }
      return result
    },
    [connectionLost],
  )

  const listToolsFn = useCallback(async (): Promise<Tool[]> => {
    const client = clientRef.current
    if (!client) throw new Error('MCP client not connected')
    const result = await client.listTools()
    setTools(result.tools)
    return result.tools
  }, [])

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <MCPClientContext.Provider
      value={{
        isConnected,
        error,
        connectionLost,
        reconnect: manualReconnect,
        callTool,
        listTools: listToolsFn,
        tools,
      }}
    >
      {children}
    </MCPClientContext.Provider>
  )
}
