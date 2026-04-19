/**
 * Quaco Voice Engine v12 — Railway Server
 * Telnyx bidirectional stream ↔ Cartesia Calls API bridge
 * 
 * Flow:
 * 1. Telnyx fires webhook on call.answered
 * 2. We tell Telnyx to start a bidirectional WebSocket stream (mulaw 8khz)
 * 3. Telnyx connects to our /telnyx-stream WS endpoint
 * 4. We connect to Cartesia /agents/stream/{id} WS
 * 5. We bridge audio: Telnyx → Cartesia (inbound from caller) and Cartesia → Telnyx (AI speech)
 */

import express from 'express';
import http from 'http';
import { WebSocket, WebSocketServer } from 'ws';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// ─── CONFIG ──────────────────────────────────────────────────
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY;
const CARTESIA_AGENT_ID = process.env.CARTESIA_AGENT_ID || 'agent_JABMUGB68t5VDQBAvms7dM';
const FROM_NUMBER = process.env.TELNYX_FROM_NUMBER || '+17372341632';
const TELNYX_CONNECTION_ID = process.env.TELNYX_CONNECTION_ID || '2940951809176372710';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://quaco-voice-engine-production.up.railway.app';

// ─── STATE ───────────────────────────────────────────────────
const activeCalls = new Map(); // callControlId → { meta, cartesiaWs, streamId }

// ─── HELPERS ─────────────────────────────────────────────────
function parseMeta(clientStateB64) {
  try {
    return JSON.parse(Buffer.from(clientStateB64 || '', 'base64').toString());
  } catch { return {}; }
}

async function telnyxCmd(callControlId, command, params = {}) {
  const resp = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/${command}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  const text = await resp.text();
  if (!resp.ok) console.error(`[telnyx] ${command} failed (${resp.status}): ${text.slice(0, 200)}`);
  return resp.ok;
}

function classifyOutcome(hangupCause, sipCode, answerTime) {
  const REDIAL_CAUSES = ['call_rejected', 'normal_clearing', 'originator_cancel'];
  const duration = answerTime ? (Date.now() - answerTime.getTime()) / 1000 : 0;
  if (hangupCause === 'user_busy') return 'dial_busy';
  if (hangupCause === 'no_answer' || hangupCause === 'no_user_response') return 'dial_no_answer';
  if (hangupCause === 'originator_cancel' && !answerTime) return 'dial_no_answer';
  if (!answerTime) return 'dial_no_answer';
  if (duration < 5) return 'voicemail_reached'; // picked up then hung up very fast = VM
  if (duration >= 5 && duration < 15) return 'voicemail_reached';
  return 'picked_up';
}

async function updateContactOutcome(contactId, batchId, outcome) {
  if (!SUPABASE_URL || !contactId) return;
  const isDone = outcome === 'picked_up';
  await fetch(`${SUPABASE_URL}/rest/v1/contacts?id=eq.${contactId}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status: isDone ? 'done' : 'redial',
      last_outcome: outcome,
      last_called_at: new Date().toISOString(),
    }),
  });
  console.log(`[supabase] ${contactId} → ${isDone ? 'done' : 'redial'} (${outcome})`);
}

// ─── HTTP ROUTES ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', calls: activeCalls.size, agent: CARTESIA_AGENT_ID, version: 'v12.1' });
});

// Telnyx fires HTTP webhooks here for call state events
app.post('/telnyx-webhook', async (req, res) => {
  res.sendStatus(200); // always ack immediately

  const event = req.body?.data;
  const eventType = event?.event_type;
  const payload = event?.payload || {};
  const callControlId = payload?.call_control_id;
  const clientStateB64 = payload?.client_state;
  const meta = parseMeta(clientStateB64);

  console.log(`[webhook] ${eventType} | ccid: ${callControlId?.slice(-8)}`);

  // ── CALL ANSWERED ─────────────────────────────────────────
  if (eventType === 'call.answered') {
    activeCalls.set(callControlId, { ...meta, answerTime: new Date() });

    // Tell Telnyx to start a bidirectional WebSocket stream with us
    const streamUrl = `wss://${process.env.RAILWAY_PUBLIC_DOMAIN || 'quaco-voice-engine-production.up.railway.app'}/telnyx-stream`;
    const ok = await telnyxCmd(callControlId, 'streaming_start', {
      stream_url: streamUrl,
      stream_track: 'both_tracks',
      stream_bidirectional_mode: 'rtp',
      stream_bidirectional_codec: 'PCMU',
      enable_dialogflow: false,
    });

    if (!ok) {
      console.error(`[webhook] Failed to start stream for ${callControlId}`);
    } else {
      console.log(`[webhook] Stream started → ${streamUrl}`);
    }
  }

  // ── CALL HANGUP ───────────────────────────────────────────
  if (eventType === 'call.hangup') {
    const hangupCause = payload?.hangup_cause || '';
    const sipCode = payload?.sip_hangup_cause || '';
    const callData = activeCalls.get(callControlId) || meta;
    const answerTime = callData?.answerTime || null;
    const outcome = classifyOutcome(hangupCause, sipCode, answerTime);

    console.log(`[hangup] cause=${hangupCause} sip=${sipCode} outcome=${outcome}`);

    // Close Cartesia WS if open
    const cWs = callData?.cartesiaWs;
    if (cWs && cWs.readyState === WebSocket.OPEN) cWs.close();

    activeCalls.delete(callControlId);
    await updateContactOutcome(callData?.contact_id, callData?.batch_id, outcome);
  }

  // ── STREAMING STARTED (Telnyx confirms stream is live) ─────
  if (eventType === 'call.streaming.started') {
    console.log(`[webhook] Telnyx stream live for ${callControlId?.slice(-8)}`);
  }

  if (eventType === 'call.streaming.failed') {
    console.error(`[webhook] Telnyx stream FAILED for ${callControlId?.slice(-8)}`);
  }
});

// ─── WEBSOCKET SERVER (receives audio from Telnyx) ───────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/telnyx-stream' });

wss.on('connection', (telnyxWs, req) => {
  console.log('[ws] Telnyx stream connected');
  let callControlId = null;
  let cartesiaWs = null;
  let cartesiaStreamId = null;
  let cartesiaReady = false;
  let audioBuffer = []; // buffer inbound audio until Cartesia is ready

  telnyxWs.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    const event = msg.event;

    // ── TELNYX STREAM START ──────────────────────────────────
    if (event === 'connected') {
      console.log('[ws] Telnyx stream: connected event');
      return;
    }

    if (event === 'start') {
      callControlId = msg.start?.call_control_id || msg.start?.customParameters?.call_control_id;
      const streamSid = msg.start?.stream_sid;
      console.log(`[ws] Stream start: ccid=${callControlId?.slice(-8)} sid=${streamSid}`);

      // Pull call meta
      const callData = activeCalls.get(callControlId) || {};
      const firstName = callData.first_name || 'there';
      const address = callData.address || 'your property';

      // Connect to Cartesia
      const cartesiaUrl = `wss://api.cartesia.ai/agents/stream/${CARTESIA_AGENT_ID}`;
      cartesiaWs = new WebSocket(cartesiaUrl, {
        headers: {
          Authorization: `Bearer ${CARTESIA_API_KEY}`,
          'Cartesia-Version': '2025-04-16',
        },
      });

      if (callControlId && activeCalls.has(callControlId)) {
        activeCalls.get(callControlId).cartesiaWs = cartesiaWs;
      }

      cartesiaWs.on('open', () => {
        console.log('[cartesia] WS connected, sending start event');
        cartesiaWs.send(JSON.stringify({
          event: 'start',
          config: {
            input_format: 'mulaw_8000',  // matches Telnyx audio format
          },
          agent: {
            // Pass dynamic variables into the introduction
            introduction: `Hello?`,
            system_prompt: null, // use agent's existing system prompt
          },
          metadata: {
            first_name: firstName,
            address: address,
            call_control_id: callControlId,
          },
        }));
      });

      cartesiaWs.on('message', (rawMsg) => {
        let cartesiaMsg;
        try { cartesiaMsg = JSON.parse(rawMsg); } catch { return; }

        const cEvent = cartesiaMsg.event;

        if (cEvent === 'ack') {
          cartesiaStreamId = cartesiaMsg.stream_id;
          cartesiaReady = true;
          console.log(`[cartesia] Ack received, streamId=${cartesiaStreamId}`);
          // Flush any buffered inbound audio
          for (const payload of audioBuffer) {
            cartesiaWs.send(JSON.stringify({
              event: 'media_input',
              stream_id: cartesiaStreamId,
              media: { payload },
            }));
          }
          audioBuffer = [];
        }

        // Cartesia sends TTS audio back → relay to Telnyx caller
        if (cEvent === 'media_output') {
          const audioPayload = cartesiaMsg.media?.payload;
          if (audioPayload && telnyxWs.readyState === WebSocket.OPEN) {
            telnyxWs.send(JSON.stringify({
              event: 'media',
              stream_sid: streamSid,
              media: { payload: audioPayload },
            }));
          }
        }

        // Cartesia wants to clear/interrupt
        if (cEvent === 'clear') {
          if (telnyxWs.readyState === WebSocket.OPEN) {
            telnyxWs.send(JSON.stringify({ event: 'clear', stream_sid: streamSid }));
          }
        }
      });

      cartesiaWs.on('error', (e) => console.error(`[cartesia] WS error: ${e.message}`));
      cartesiaWs.on('close', (code, reason) => {
        console.log(`[cartesia] WS closed: ${code} ${reason}`);
        cartesiaReady = false;
      });

      // Store streamSid so we can reference it in media_output handler above
      // (closure captures it)
      var streamSid = msg.start?.stream_sid;
      return;
    }

    // ── INBOUND AUDIO FROM CALLER → FORWARD TO CARTESIA ─────
    if (event === 'media') {
      const audioPayload = msg.media?.payload;
      const track = msg.media?.track; // 'inbound' = caller audio, 'outbound' = our TTS
      if (!audioPayload || track !== 'inbound') return; // only pass caller audio to Cartesia

      if (cartesiaReady && cartesiaWs?.readyState === WebSocket.OPEN) {
        cartesiaWs.send(JSON.stringify({
          event: 'media_input',
          stream_id: cartesiaStreamId,
          media: { payload: audioPayload },
        }));
      } else {
        audioBuffer.push(audioPayload); // buffer until Cartesia is ready
        if (audioBuffer.length > 200) audioBuffer.shift(); // cap buffer
      }
      return;
    }

    // ── STREAM STOP ──────────────────────────────────────────
    if (event === 'stop') {
      console.log('[ws] Telnyx stream stopped');
      if (cartesiaWs?.readyState === WebSocket.OPEN) cartesiaWs.close();
    }
  });

  telnyxWs.on('close', () => {
    console.log('[ws] Telnyx WS closed');
    if (cartesiaWs?.readyState === WebSocket.OPEN) cartesiaWs.close();
  });

  telnyxWs.on('error', (e) => console.error(`[ws] Telnyx WS error: ${e.message}`));
});

// ─── START ───────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 Quaco Voice Engine v12.1 (bidirectional RTP fix) on port ${PORT}`);
  console.log(`   Agent ID: ${CARTESIA_AGENT_ID}`);
  console.log(`   Webhook: ${RAILWAY_URL}/telnyx-webhook`);
  console.log(`   Stream WS: wss://.../telnyx-stream\n`);
});
