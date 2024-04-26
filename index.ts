import { createClient } from 'redis'
import { nanoid } from 'nanoid'
import { type ServerWebSocket } from 'bun'

const client = await createClient({ url: 'redis://localhost:6379' })
  .on('error', err => console.log('Redis Client Error', err))
  .connect()

const socket = new WebSocket('wss://lc-rpc-goldberg.avail.tools:443/ws')

interface WS extends ServerWebSocket<unknown> {
  data: WSData
}

interface WSData {
  id: string
}

interface JSONRPCResponse extends MessageEvent<any> {
  jsonrpc: string
  method: string
  id: string | number
  result: string
  params: [number | string | null | unknown]
}

const server = Bun.serve({
  async fetch (req, server) {
    // upgrade the request to a WebSocket
    if (server.upgrade(req)) {
      return // do not return a Response
    }
    return new Response('Upgrade failed :(', { status: 500 })
  },
  websocket: {
    async message (ws: WS, message) {
      const body = JSON.parse(message as string)
      console.log({ requestBody: body })
      console.log({ stringified: JSON.stringify(body) })
      const requestId = body.id
      console.log({ connId1: ws.data.id, requestId1: body.id })
      let ret = await client.hGet(ws.data.id.toString(), body.id.toString())
      body.id = String(ws.data.id) + String(body.id)
      console.log({ ret })
      if (ret === null) {
        console.log({ id: ws.data.id })
        socket.send(JSON.stringify(body))
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        socket.addEventListener('message', async (event): Promise<void> => {
          const body: JSONRPCResponse = JSON.parse(event.data as string)
          if (body.method === 'chain_subscribeFinalizedHeads') {
            ws.publish('chain_subscribeFinalizedHeads', body.params[0] as string)
            return
          }
          console.log({ body })
          const connId = body.id.toString().slice(0, 21)
          const requestId = parseInt(body.id.toString().slice(21, body.id.toString().length))
          body.id = requestId
          console.log({ connId })
          console.log({ requestId })
          console.log({ eventData: event.data })
          await client.hSet(connId, requestId, JSON.stringify(body))
        })
        while (await client.hGet(ws.data.id.toString(), requestId.toString()) === null) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        ret = await client.hGet(ws.data.id.toString(), requestId.toString())
        console.log({ responseBody: ret })
        ws.send(ret as string)
      } else {
        console.log({ resposeBody: ret })
        ws.send(ret as string)
      }
    }, // a message is received
    async open (ws) {
      ws.data = {
        id: nanoid()
      }
      console.log('open')
    }, // a socket is opened
    async close (_ws, _code, _message) {
      console.log('close')
    }, // a socket is closed
    async drain (_ws) {
      console.log('drain')
    }, // the socket is ready to receive more data,
    perMessageDeflate: true,
    idleTimeout: 60,
    maxPayloadLength: 1024 * 1024
  } // handlers
})

console.log(`🦻 Listening on ${server.hostname}:${server.port}`)
