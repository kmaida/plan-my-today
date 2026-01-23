# 🔐 Keycard Hello MCP Server

A **production-ready MCP server** demonstrating OAuth 2.0 authentication with Keycard's Security Token Service (STS). This project showcases best practices for building secure, type-safe, and modular MCP servers with enterprise-grade observability.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org/)
[![MCP Protocol](https://img.shields.io/badge/MCP-2024--11--05-purple)](https://modelcontextprotocol.io/)
[![OAuth 2.0](https://img.shields.io/badge/OAuth-2.0-orange)](https://oauth.net/2/)

## 🎯 What This Demonstrates

- **🔒 OAuth 2.0 Authentication** - Secure authentication via Keycard STS
- **✨ Type Safety** - Full TypeScript with Zod runtime validation
- **🏗️ Modular Architecture** - Clean separation of concerns for easy extension
- **🚀 Production Ready** - Error handling, validation, and comprehensive logging
- **📚 Educational** - Well-documented code showing MCP best practices
- **🧪 Testing Framework** - Jest with coverage, integration tests, and watch modes
- **📊 Observability** - OpenTelemetry integration with traces and metrics

## 🚀 Quick Start

## 🏗️ Architecture

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐
│   Cursor    │───▶│  MCP Server  │───▶│ Keycard STS │
│    IDE      │    │ (localhost:  │    │             │
│             │    │     8888)    │    │             │
└─────────────┘    └──────────────┘    └─────────────┘
       │                   │                   │
   OAuth Flow          JWT Validation      Token Issuance
```

### 🔄 Authentication Flow

1. **Cursor** discovers OAuth endpoints from MCP server
2. **User** authenticates via Keycard STS (redirected to identity provider)
3. **Keycard STS** issues JWT access tokens
4. **MCP Server** validates tokens and grants access to tools

### Prerequisites

- **Node.js 18+** and **npm**
- **Cursor IDE** (or any MCP-compatible client)
- **Keycard account** with access to the Console
- **Configured Keycard zone** (for authentication)

### 1. Clone & Install

```bash
git clone https://github.com/keycardai/hello-mcp-server.git
cd hello-mcp-server
npm install
```

### 2. Configure Environment

Create a `.env` file:

```bash
# Required: Your Keycard STS issuer URL
KEYCARD_STS_ISSUER_URL=https://your-zone-id.keycard.cloud

# Required for token exchange (e.g., calendar tool)
KEYCARD_CLIENT_ID=your-client-id
KEYCARD_CLIENT_SECRET=your-client-secret

# Optional: Server configuration
PORT=8888
HOST=localhost
```

💡 **Finding your Zone ID**: 
1. Log into the [Keycard Console](https://console.keycard.ai)
2. Navigate to **Zone Settings** 
3. Copy the **Zone ID** (e.g., `j434uokph8th1ia1npxiaykh7p`)
4. Replace `your-zone-id` in your STS URL

> **Note**: Use the zone ID, not the zone name or label.

### 3. Start the Server

```bash
# Development mode with auto-reload
npm run dev

# Production mode
npm run build && npm start
```

You should see:
```
🚀 Keycard Hello MCP Server started!
🔗 MCP Endpoint: http://localhost:8888/mcp
🔐 STS Issuer: https://your-zone-id.keycard.cloud
🛠️  Available Tools: keycard-logo, whoami
```

### 4. Use tunnel for local dev

In order for Keycard to complete the token exchange with Google, the MCP server must be publicly accessible. Use Ngrok, Cloudflared, or another tunneling service. Try to use the same tunnel URL, otherwise settings will need to be updated in Keycard and in project files every time the tunnel changes.

### 5. Configure Cursor IDE

Add to your Cursor MCP settings:

```json
{
  "mcpServers": {
    "keycard-hello-mcp": {
      "url": "<https://unpreferable-cropless-dede.ngrok-free.dev>/mcp"
    }
  }
}
```

### 6. Test Authentication

1. **Restart Cursor** to pick up the new MCP server
2. **Cursor will show "needs login"** for the server
3. **Click to authenticate** → complete OAuth flow
4. **Use the tools**: `keycard-logo`, `whoami`, `list-calendar-events`, `list-linear-issues`, `list-gmail-todos`

### 7. REST API Endpoints (Optional)

The server also provides REST API endpoints for easier tool access:

- **List tools**: `GET /api/tools` - Returns list of available tools
- **Call tool**: `POST /api/tools/:toolName` - Execute a tool with JSON body as arguments

Example:
```bash
# List available tools
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8888/api/tools

# Call a tool
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"maxResults": 10}' \
  http://localhost:8888/api/tools/list-calendar-events
```

These endpoints use the same authentication as the MCP protocol endpoint.

## 🛠️ Available Tools

### `keycard-logo`
Displays the official Keycard ASCII art logo.

### `whoami`
Provides detailed information about the authenticated user including:
- Client ID and authentication scopes
- JWT payload with user information
- Token expiration and timing details
- Custom claims and metadata

### `list-calendar-events`
Lists upcoming events from the user's Google Calendar within a time range.

### `list-linear-issues`
Fetches issues assigned to you from Linear, grouped by status (In Progress, To Do, Backlog, etc.). Includes priority indicators, due dates with urgency warnings, and project/team info.

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `KEYCARD_STS_ISSUER_URL` | Keycard STS issuer URL (single-tenant mode) | - | ✅* |
| `ISSUER_BASE_DOMAIN` | Base domain for STS (multi-tenant mode) | - | ✅* |
| `MCP_BASE_DOMAIN` | Base domain for MCP server (multi-tenant mode) | - | ✅* |
| `KEYCARD_CLIENT_ID` | Keycard client ID (token exchange) | - | ✅ for token exchange |
| `KEYCARD_CLIENT_SECRET` | Keycard client secret (token exchange) | - | ✅ for token exchange |
| `PORT` | Server port | `8888` | |
| `HOST` | Server host | `localhost` | |
| `LOG_LEVEL` | Logging level | `INFO` | |
| `ENABLE_OTEL` | Enable OpenTelemetry | `true` | |
| `OTEL_SERVICE_NAME` | Service name for telemetry | `hello-mcp-server` | |
| `OTEL_ENVIRONMENT` | Environment for telemetry | `development` | |

*Either `KEYCARD_STS_ISSUER_URL` (single-tenant) OR `ISSUER_BASE_DOMAIN` + `MCP_BASE_DOMAIN` (multi-tenant) is required.

### Calendar Tool Setup

The `list-calendar-events` tool uses Keycard STS token exchange to mint a
Google Calendar access token. Make sure the Keycard client you configured:

- Has token exchange enabled.
- Is allowed to exchange for the resource `https://www.googleapis.com/calendar/v3`.
- Has access to the scope `https://www.googleapis.com/auth/calendar.readonly`.

If you see `invalid_grant` or "Client is not allowed to exchange token for this resource",
recheck the client permissions in the Keycard Console and confirm your issuer/zone.

### Linear Tool Setup

The `list-linear-issues` tool uses Keycard STS token exchange to mint a
Linear access token. Make sure:

1. **Linear OAuth App**: Create an OAuth app in Linear (Settings → API → OAuth Applications)
2. **Keycard Credential Provider**: Add Linear as a credential provider in your Keycard zone
3. **Token Exchange Permission**: Configure your Keycard client to exchange tokens for:
   - Resource: `https://api.linear.app`
   - Scope: `read`

If you see token exchange errors, verify the Linear credential provider is properly connected in Keycard.

If you receive token exchange errors and are running the MCP server on localhost, use a tunnel to expose a public URL for the MCP server.

### Gmail Tool Setup

The `list-gmail-todos` tool uses Keycard STS token exchange to mint a Gmail access token. Make sure:

1. **Gmail Credential Provider**: Add Gmail as a credential provider in your Keycard zone
2. **Token Exchange Permission**: Configure your Keycard client to exchange tokens for:
   - Resource: `https://www.googleapis.com/gmail/v1`
   - Scope: `https://www.googleapis.com/auth/gmail.readonly`

The tool finds:
- **Potential Todos**: Emails containing keywords like "todo", "action", "follow up", "please", etc.
- **Needs Reply**: Unread or important emails sent to you (not from you)
- **Unread Emails**: All unread emails
- **Important Emails**: Emails marked as important

You can customize the search with:
- `daysBack`: How many days to look back (default: 7)
- `maxResults`: Maximum emails to return (default: 20)
- `includeUnread`, `includeImportant`, `includeNeedsReply`: Filter options
- `searchQuery`: Custom Gmail search query (e.g., `is:unread from:example@email.com`)

If you see token exchange errors, verify the Gmail credential provider is properly connected in Keycard.


### Multi-Tenant Configuration

For multi-tenant deployments (serving multiple organizations/zones), use these environment variables instead:

```bash
# Multi-tenant mode
ISSUER_BASE_DOMAIN=keycard.cloud
MCP_BASE_DOMAIN=mcp.example.com

# Other configuration
PORT=8888
ENABLE_OTEL=true
```

This enables dynamic issuer discovery based on subdomain routing, allowing one deployment to serve multiple Keycard zones.

### Observability

The server includes comprehensive observability features:

- **Structured Logging**: Environment-aware logging with trace correlation
- **Request Tracing**: Full distributed tracing with OpenTelemetry
- **Metrics Collection**: Performance and usage metrics
- **Health Checks**: Available at `/health`

In development, logs are formatted for console readability. In production, logs are sent to configured OTLP endpoints.

## 🏗️ Architecture

```
src/
├── config.ts              # Configuration management
├── index.ts               # Application entry point
├── server.ts              # Express server setup
├── middleware/            # Express middlewares
│   ├── auth.ts           # Authentication middleware
│   └── logging.ts        # Request logging and tracing
├── observability/         # Telemetry and logging
│   ├── logger.ts         # Structured logger
│   └── telemetry.ts      # OpenTelemetry setup
├── tools/                 # MCP tools
│   ├── index.ts          # Tool registration
│   ├── logo.ts           # Keycard logo tool
│   └── whoami.ts         # User information tool
└── types/                 # Type definitions
    ├── auth.ts           # Authentication types
    └── index.ts          # Exported types
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run integration tests
npm run test:integration

# Watch mode for development
npm run test:watch
```

## 📊 Code Quality

```bash
# Lint code
npm run lint

# Fix linting issues
npm run lint:fix

# Format code
npm run format

# Check all (lint + format)
npm run check

# Fix all issues
npm run check:fix
```

## 🔗 MCP Integration

### Cursor IDE

1. Start the server: `npm run dev`
2. In Cursor, go to Settings > MCP Servers
3. Add server: `http://localhost:8888/mcp`

## 🚦 Health Checks

The server provides a health check endpoint at `/health`:

```bash
curl http://localhost:8888/health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "service": "todo-mcp-server",
  "version": "0.1.0"
}
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and quality checks
5. Submit a pull request

## 📄 License

Apache-2.0 License - see LICENSE file for details.