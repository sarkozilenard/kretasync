import { createApp } from '../src/app';

const handle = createApp();

// Vercel Functions (Node.js) – Web Standard Request/Response
export const GET = (req: Request) => handle(req);
export const POST = (req: Request) => handle(req);
export const DELETE = (req: Request) => handle(req);
