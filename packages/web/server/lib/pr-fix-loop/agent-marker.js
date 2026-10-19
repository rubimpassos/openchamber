// What the agent writes on GitHub ends with a visible line and a hidden
// marker. The loop skips every comment that carries the marker, whatever its
// author settings say, so the agent's own replies never come back to it as
// new feedback when it posts with the same account as the reviewer.
//
// The marker identifies text; it is not a signature. Anyone can paste it to
// make the loop skip their comment. That only suppresses a reaction: it
// grants no access and triggers no work.

const AGENT_MARKER = '<!-- openchamber-agent:v1 -->';
export const AGENT_SIGNATURE = `<sub>Written by the OpenChamber agent</sub>\n${AGENT_MARKER}`;

// Only the HTML comment counts: quoting the visible line silences nobody.
const MARKER_PATTERN = /<!--\s*openchamber-agent:v\d+\s*-->/;

export const isAgentText = (body) => MARKER_PATTERN.test(String(body ?? ''));

/** The body as posted: unchanged when it already carries the marker. */
export const markAgentText = (body) => {
  const text = String(body ?? '');
  return isAgentText(text) ? text : `${text.trimEnd()}\n\n${AGENT_SIGNATURE}`;
};
