import type { BotArtifactReference } from '../bots/artifacts-contract.js';
import type { Request, Response } from '../shared/http-contracts.js';
import type { ResultFields } from './runtime.js';

export const RENDER_CAPTURE_MEDIA_TYPE = 'application/x-openchamber-render+ndjson';

export const createRenderCaptureReply = (req: Pick<Request, 'headers'>, res: Response) => {
  let streaming = false;
  const onArtifactCaptured = req.headers.accept === RENDER_CAPTURE_MEDIA_TYPE
    ? async (artifact: BotArtifactReference) => {
      if (!streaming) {
        res.type(RENDER_CAPTURE_MEDIA_TYPE).set('Cache-Control', 'no-store, no-transform');
        streaming = true;
      }
      res.write(`${JSON.stringify({ artifact })}\n`);
    }
    : undefined;
  const reply = (result: ResultFields) => streaming
    ? res.end(`${JSON.stringify({ result })}\n`)
    : res.json(result);
  return { onArtifactCaptured, reply };
};

export const RENDER_CAPTURE_SETUP = String.raw`        let capturedFields = {}
        const readRenderResponse = async (response) => {
          if (response.headers.get("content-type")?.split(";")[0] !== ${JSON.stringify(RENDER_CAPTURE_MEDIA_TYPE)}) return response.text()
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let pending = ""
          let content
          try {
            while (true) {
              const { value, done } = await reader.read()
              pending += decoder.decode(value, { stream: !done })
              let end
              while ((end = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, end)
                pending = pending.slice(end + 1)
                const frame = JSON.parse(line)
                if (frame.artifact) {
                  capturedFields = { artifact: frame.artifact }
                  await progress()
                } else if (frame.result) content = JSON.stringify(frame.result)
              }
              if (done) break
            }
            if (pending || content === undefined) throw new Error("OpenChamber render response ended before its result")
            return content
          } finally { reader.releaseLock() }
        }
`;
