'use strict'
import { createClient } from 'redis'
import { nanoid } from 'nanoid'
import { type ServerWebSocket } from 'bun'

const client = await createClient({ url: 'redis://localhost:6379' })
  .on('error', err => console.error('Unable to connect to DB!', err))
  .connect()

let socket = new WebSocket('wss://avail-turing.public.blastapi.io')
interface WS extends ServerWebSocket<unknown> {
  data: {
    id: string
  }
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
    return new Response('❌ Upgrade failed', { status: 500 })
  },
  websocket: {
    async message (ws: WS, message) {
      const body = JSON.parse(message as string)
      if (body.method === 'chain_subscribeFinalizedHeads') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: await client.get('chain_subscribeFinalizedHeads')
        }), true)

        return
      } else if (body.method === 'grandpa_subscribeJustifications') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: await client.get('grandpa_subscribeJustifications')
        }), true)
        return
      }
      const requestId = body.id
      body.id = String(ws.data.id) + String(body.id)
      let ret = await client.get(body.id)
      const cachedRequest = structuredClone(body)
      delete cachedRequest.jsonrpc
      delete cachedRequest.id
      const cachedResponse = await client.get(JSON.stringify(cachedRequest))
      if (cachedResponse !== null) {
        const cachedResponseObj = JSON.parse(cachedResponse)
        cachedResponseObj.id = requestId
        ws.send(JSON.stringify(cachedResponseObj), true)
        return
      } else {
        await client.set(`${body.id as string}-cache`, JSON.stringify(cachedRequest), { EX: 20 })
      }
      if (ret === null) {
        socket.send(JSON.stringify(body))
        while (ret === null) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          ret = await client.get(String(body.id))
        }
        const returnObj = JSON.parse(ret)
        returnObj.id = requestId
        ws.send(JSON.stringify(returnObj), true)
      } else {
        const returnObj = JSON.parse(ret)
        returnObj.id = requestId
        ws.send(JSON.stringify(returnObj), true)
      }
    }, // a message is received
    async open (ws) {
      ws.data = {
        id: nanoid()
      }
      ws.subscribe('chain_finalizedHead')
      ws.subscribe('grandpa_justifications')
    }, // a socket is opened
    perMessageDeflate: true,
    idleTimeout: 60,
    maxPayloadLength: 1024 * 1024
  } // handlers
})
let finalizedHeadId: string
let grandpaId: string
socket.onclose = () => {
  socket = new WebSocket('wss://turing-testnet.avail-rpc.com')
}
socket.onopen = () => {
  finalizedHeadId = nanoid()
  grandpaId = nanoid()
  socket.send(JSON.stringify({
    jsonrpc: '2.0',
    id: finalizedHeadId,
    method: 'chain_subscribeFinalizedHeads'
  }))
  socket.send(JSON.stringify({
    jsonrpc: '2.0',
    id: grandpaId,
    method: 'grandpa_subscribeJustifications'
  }))
}
// eslint-disable-next-line @typescript-eslint/no-misused-promises
socket.addEventListener('message', async (event): Promise<void> => {
  const body: JSONRPCResponse = JSON.parse(event.data as string)
  if (body === null || body === undefined) {
    return
  }
  if (body.id === finalizedHeadId) {
    await client.set('chain_subscribeFinalizedHeads', String(body.result))
    return
  } else if (body.id === grandpaId) {
    await client.set('grandpa_subscribeJustifications', String(body.result))
    return
  }
  if (body.method === 'chain_finalizedHead' && body.params !== undefined) {
    server.publish('chain_finalizedHead', JSON.stringify(body), true)
    return
  }
  if (body.method === 'grandpa_justifications' && body.params !== undefined) {
    server.publish('grandpa_justifications', JSON.stringify(body), true)
    return
  }
  if (body.id === null || body.id === undefined) {
    return
  }
  await client.set(String(body.id), JSON.stringify(body), { EX: 20 })
  const cachedRequest = await client.get(`${body.id}-cache`)
  if (cachedRequest !== null) {
    await client.set(cachedRequest, JSON.stringify(body), { EX: 20 })
  }
})

console.log(`✨ Starting hyperws on ${server.hostname}:${server.port}`)
