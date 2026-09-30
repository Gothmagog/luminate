import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { appendFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const SONNET_MODEL = 'us.anthropic.claude-sonnet-4-6'
const HAIKU_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'

// ─── Audit log ────────────────────────────────────────────────────────────────

const LOG_PATH = resolve(process.cwd(), 'bedrock-audit.log')
let callSeq = 0

/** Clear the log file and write a session header when the dev server starts. */
function initAuditLog() {
  const header =
    `${'═'.repeat(80)}\n` +
    `LUMINATE BEDROCK AUDIT LOG\n` +
    `Session started: ${new Date().toISOString()}\n` +
    `Profile: ${process.env.AWS_PROFILE ?? '(default chain)'} | ` +
    `Region: ${process.env.AWS_REGION ?? 'us-east-1'}\n` +
    `${'═'.repeat(80)}\n`
  try {
    writeFileSync(LOG_PATH, header)
  } catch (e) {
    console.warn('[Audit] Could not create log file:', e.message)
  }
}

/**
 * Appends one structured entry to bedrock-audit.log.
 * Each entry shows the exact request (system, messages, schema) and the exact
 * response text so the full input/output can be inspected for debugging.
 */
function writeAuditEntry({ modelId, temperature, maxTokens, system, messages, jsonSchema, responseText, error, durationMs }) {
  callSeq++
  const modelLabel = modelId.includes('haiku') ? 'haiku' : 'sonnet'
  const callKind   = jsonSchema ? 'structured' : 'text'
  const status     = error ? `ERROR` : `OK`

  const lines = []
  lines.push(`\n${'─'.repeat(80)}`)
  lines.push(`#${String(callSeq).padStart(3, '0')}  ${new Date().toISOString()}  ${modelLabel}  ${callKind}  temp=${temperature}  maxTok=${maxTokens}  ${durationMs}ms  [${status}]`)
  lines.push(`${'─'.repeat(80)}`)

  if (system) {
    lines.push(`── SYSTEM ${'─'.repeat(71)}`)
    lines.push(system)
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    lines.push(`── ${msg.role.toUpperCase()} MESSAGE ${i + 1} ${'─'.repeat(60)}`)
    lines.push(msg.content)
  }

  if (jsonSchema) {
    lines.push(`── JSON SCHEMA ${'─'.repeat(65)}`)
    lines.push(JSON.stringify(jsonSchema, null, 2))
  }

  if (error) {
    lines.push(`── ERROR ${'─'.repeat(71)}`)
    lines.push(String(error))
  } else {
    lines.push(`── RESPONSE ${'─'.repeat(68)}`)
    lines.push(responseText)
  }

  lines.push('')

  try {
    appendFileSync(LOG_PATH, lines.join('\n'))
  } catch (e) {
    console.warn('[Audit] Could not write log entry:', e.message)
  }
}

// ─── Bedrock proxy plugin ─────────────────────────────────────────────────────

/**
 * Vite plugin that proxies POST /api/chat to AWS Bedrock at dev-server time.
 * Runs entirely in Node.js — the browser never touches AWS credentials.
 *
 * Auth: reads AWS_PROFILE env var; if absent, falls back to the default
 * credential chain (instance role, env vars, etc.).
 * Region: reads AWS_REGION env var; defaults to us-east-1.
 */
function bedrockProxyPlugin() {
  return {
    name: 'bedrock-proxy',
    configureServer(server) {
      initAuditLog()

      server.middlewares.use('/api/chat', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method Not Allowed')
          return
        }

        let rawBody = ''
        req.on('data', (chunk) => { rawBody += chunk })
        req.on('end', async () => {
          const startMs = Date.now()
          let parsedRequest = {}

          try {
            const { BedrockRuntimeClient, InvokeModelCommand } =
              await import('@aws-sdk/client-bedrock-runtime')
            const { fromIni } = await import('@aws-sdk/credential-providers')

            const { system, messages, useHaiku = false, temperature = 0.7, maxTokens = 4096, jsonSchema } =
              JSON.parse(rawBody)

            parsedRequest = { system, messages, jsonSchema, temperature, maxTokens }

            const modelId = useHaiku ? HAIKU_MODEL : SONNET_MODEL
            const region  = process.env.AWS_REGION || 'us-east-1'
            const profile = process.env.AWS_PROFILE

            const client = new BedrockRuntimeClient({
              region,
              ...(profile ? { credentials: fromIni({ profile }) } : {}),
            })

            const bedrockBody = {
              anthropic_version: 'bedrock-2023-05-31',
              max_tokens: maxTokens,
              temperature,
              messages,
              ...(system ? { system } : {}),
              ...(jsonSchema ? { output_config: { format: { type: 'json_schema', schema: jsonSchema } } } : {}),
            }

            const command = new InvokeModelCommand({
              modelId,
              body: JSON.stringify(bedrockBody),
              contentType: 'application/json',
              accept: 'application/json',
            })

            const bedrockRes  = await client.send(command)
            const parsed      = JSON.parse(new TextDecoder().decode(bedrockRes.body))
            const text        = parsed.content[0].text
            const durationMs  = Date.now() - startMs

            writeAuditEntry({ modelId, temperature, maxTokens, ...parsedRequest, responseText: text, durationMs })

            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ text }))
          } catch (err) {
            const durationMs = Date.now() - startMs
            console.error('[Bedrock Proxy]', err.message ?? err)
            writeAuditEntry({ modelId: parsedRequest.system ? SONNET_MODEL : '?', temperature: parsedRequest.temperature ?? 0.7, maxTokens: parsedRequest.maxTokens ?? 0, ...parsedRequest, error: err.message ?? err, durationMs })
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: err.message ?? 'Unknown Bedrock error' }))
          }
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), bedrockProxyPlugin()],
})
