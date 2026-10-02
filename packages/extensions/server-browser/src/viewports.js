const PRESETS = Object.freeze({
  mobile: Object.freeze({ width: 390, height: 844, mobile: true }),
  tablet: Object.freeze({ width: 768, height: 1024, mobile: false }),
  desktop: Object.freeze({ width: 1440, height: 900, mobile: false }),
});

export const MAX_VIEWPORT_DIMENSION = 3840;

export const presetViewport = (mode) => PRESETS[mode] ?? null;

export const viewportSummary = ({ width, height }) => {
  for (const [mode, preset] of Object.entries(PRESETS)) {
    if (preset.width === width && preset.height === height) return { mode, width, height };
  }
  return { mode: 'custom', width, height };
};

const cssDimension = (value, devicePixelRatio) => Math.min(
  MAX_VIEWPORT_DIMENSION,
  Math.max(1, Math.round(value / devicePixelRatio)),
);

// The host measures the panel in device pixels; pages lay out in CSS pixels.
export const cssSize = ({ width, height }, devicePixelRatio) => ({
  width: cssDimension(width, devicePixelRatio),
  height: cssDimension(height, devicePixelRatio),
});

// Pages render at the viewer's pixel density so the streamed picture is as
// sharp as the screen showing it. Capped so a 4K panel at 3x cannot push
// frames past what the stream carries.
export const MAX_DEVICE_SCALE = 2;
const MAX_FRAME_PIXELS = 3840 * 2400;

export const deviceScale = ({ width, height }, ratio) => {
  const wanted = Math.min(MAX_DEVICE_SCALE, Math.max(1, Number.isFinite(ratio) ? ratio : 1));
  const area = Math.max(1, width * height);
  const fits = Math.sqrt(MAX_FRAME_PIXELS / area);
  return Math.max(1, Math.min(wanted, fits));
};

export const applyViewport = (cdp, sessionId, viewport) => cdp.sendSession(sessionId, 'Emulation.setDeviceMetricsOverride', {
  width: viewport.width,
  height: viewport.height,
  deviceScaleFactor: deviceScale(viewport, viewport.scale),
  mobile: viewport.mobile,
});

// A screenshot for the agent or an annotation stays in CSS pixels whatever the
// render density: callers map element bounds onto it one to one.
export const cssScreenshotParams = (viewport, format = 'png') => ({
  format,
  clip: {
    x: 0,
    y: 0,
    width: viewport.width,
    height: viewport.height,
    scale: 1 / deviceScale(viewport, viewport.scale),
  },
});
