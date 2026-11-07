// A real user prompt, as the host publishes it. Every user message the host creates carries an id from
// `createMessage`, and the stop advisory's one-message-per-prompt bound keys on that id, so a test harness that opens
// turns without delivering this message runs the gate in a state the host cannot produce.
let sequence = 0

export function userMessage(label, turn = 0) {
  sequence += 1
  return {
    id: `prompt-${label}-${turn}-${sequence}`, role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'continue' }],
  }
}
