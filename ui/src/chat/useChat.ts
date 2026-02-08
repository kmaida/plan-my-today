import { useState, useCallback, useRef } from 'react'
import { useMCP } from '../mcp'
import type {
  ChatMessage,
  ToolCall,
  Message,
  ContentBlock,
  ToolDefinition,
  AnthropicResponse,
} from './types'

const API_BASE = import.meta.env.VITE_API_BASE || '/api'
const MAX_TOOL_ROUNDS = 10 // Safety limit to prevent infinite loops

/** Convert MCP tool schemas to Anthropic tool format. */
function toAnthropicTools(mcpTools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>): ToolDefinition[] {
  return mcpTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
  }))
}

/** Generate a simple unique ID. */
function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * Truncate a tool result string to avoid blowing up the Anthropic context window.
 * 30K chars ≈ ~8K tokens — plenty for Claude to summarise while staying well
 * within limits even after multiple tool rounds.
 */
const MAX_TOOL_RESULT_CHARS = 30_000

function truncateToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text
  return text.slice(0, MAX_TOOL_RESULT_CHARS) + '\n\n[... result truncated due to size ...]'
}

export interface UseChatReturn {
  messages: ChatMessage[]
  isLoading: boolean
  error: string | null
  sendMessage: (text: string) => Promise<void>
  clearMessages: () => void
}

export function useChat(systemPrompt?: string): UseChatReturn {
  const { callTool, tools: mcpTools, isConnected } = useMCP()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Keep a ref to the full Anthropic message history (for context continuity)
  const historyRef = useRef<Message[]>([])

  const sendMessage = useCallback(async (text: string) => {
    if (!isConnected) {
      setError('MCP client not connected — sign in first')
      return
    }

    setError(null)
    setIsLoading(true)

    // Add user message to UI
    const userMsg: ChatMessage = { id: uid(), role: 'user', text, timestamp: Date.now() }
    setMessages((prev) => [...prev, userMsg])

    // Add to Anthropic history
    historyRef.current.push({ role: 'user', content: text })

    try {
      const tools = toAnthropicTools(mcpTools)
      let rounds = 0

      // Agentic loop: keep going while Claude wants to call tools
      while (rounds < MAX_TOOL_ROUNDS) {
        rounds++

        const response = await callChatAPI(historyRef.current, tools, systemPrompt)

        // Extract text and tool_use blocks from Claude's response
        const textParts: string[] = []
        const toolUseBlocks: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> = []

        for (const block of response.content) {
          if (block.type === 'text') textParts.push(block.text)
          if (block.type === 'tool_use') toolUseBlocks.push(block as typeof toolUseBlocks[number])
        }

        // Add assistant response to history
        historyRef.current.push({ role: 'assistant', content: response.content })

        if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
          // No more tool calls — final response
          const assistantMsg: ChatMessage = {
            id: uid(),
            role: 'assistant',
            text: textParts.join('\n'),
            timestamp: Date.now(),
          }
          setMessages((prev) => [...prev, assistantMsg])
          break
        }

        // Execute tool calls
        const toolCalls: ToolCall[] = []
        const toolResults: ContentBlock[] = []

        for (const block of toolUseBlocks) {
          let resultText: string
          let isError = false

          try {
            const result = await callTool(block.name, block.input)
            // Extract text from MCP result
            const content = result.content as Array<{ type: string; text?: string }> | undefined
            const textItem = content?.find((c) => c.type === 'text')
            resultText = textItem?.text ?? JSON.stringify(result)
          } catch (err) {
            resultText = err instanceof Error ? err.message : String(err)
            isError = true
          }

          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input,
            result: resultText,
            isError,
          })

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: truncateToolResult(resultText),
            is_error: isError,
          })
        }

        // Show assistant message with tool calls in UI (intermediate turn)
        if (textParts.length > 0 || toolCalls.length > 0) {
          const intermediateMsg: ChatMessage = {
            id: uid(),
            role: 'assistant',
            text: textParts.join('\n'),
            toolCalls,
            timestamp: Date.now(),
          }
          setMessages((prev) => [...prev, intermediateMsg])
        }

        // Add tool results to history so Claude can see them
        historyRef.current.push({ role: 'user', content: toolResults })
      }

      if (rounds >= MAX_TOOL_ROUNDS) {
        setError('Reached maximum tool call rounds — stopping to avoid infinite loop')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Chat request failed'
      setError(msg)
    } finally {
      setIsLoading(false)
    }
  }, [isConnected, mcpTools, callTool, systemPrompt])

  const clearMessages = useCallback(() => {
    setMessages([])
    historyRef.current = []
    setError(null)
  }, [])

  return { messages, isLoading, error, sendMessage, clearMessages }
}

// ── API call ────────────────────────────────────────────────────────────────

async function callChatAPI(
  messages: Message[],
  tools: ToolDefinition[],
  system?: string,
): Promise<AnthropicResponse> {
  const body: Record<string, unknown> = { messages }
  if (system) body.system = system
  if (tools.length > 0) body.tools = tools

  const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Chat API error (${res.status}): ${errText}`)
  }

  return await res.json() as AnthropicResponse
}
