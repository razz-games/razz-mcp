// Brand-agnostic configuration - all platform references come from env/config
export const config = {
  platformName: process.env.PLATFORM_NAME || "razz",
  toolPrefix: process.env.TOOL_PREFIX || "razz",
  wsUrl: process.env.PLATFORM_WS_URL || "wss://razz.games/ws",
  apiUrl: process.env.PLATFORM_API_URL || "https://razz.games/api",
  apiKey: process.env.RAZZ_API_KEY || "",
};
