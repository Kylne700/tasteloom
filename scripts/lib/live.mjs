// Where everything captured from live services goes (run JSON, live screenshots, the dev server's state and log): outside the repository,
// because Qloo, Channel3 and Tavily answers are not ours to commit. Override with TASTELOOM_LIVE_DIR.
import os from 'node:os';
import path from 'node:path';

export const LIVE_DIR = process.env.TASTELOOM_LIVE_DIR || path.join(os.tmpdir(), 'tasteloom-live');
export const LIVE_SHOTS = path.join(LIVE_DIR, 'screens');
