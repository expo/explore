import { viewerIndexHtml } from "../../../generated/viewer-entry.js";
import { previewResponse, previewUnsupported, type PreviewEnvironment } from "../../../server/preview";

export function GET(request: Request) { return previewResponse(request, { env: process.env as PreviewEnvironment, indexHtml: viewerIndexHtml }); }
export const HEAD = previewUnsupported;
export const POST = previewUnsupported;
export const PUT = previewUnsupported;
export const PATCH = previewUnsupported;
export const DELETE = previewUnsupported;
export const OPTIONS = previewUnsupported;
