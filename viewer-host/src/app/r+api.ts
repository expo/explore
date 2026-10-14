import { viewerIndexHtml } from "../generated/viewer-entry.js";
import { publicViewerResponse, publicViewerUnsupported } from "../server/public-viewer";

/** The report page's earlier address, kept for links in existing pull-request comments. */
export function GET(request: Request) { return publicViewerResponse(request, viewerIndexHtml); }
export const HEAD = publicViewerUnsupported;
export const POST = publicViewerUnsupported;
export const PUT = publicViewerUnsupported;
export const PATCH = publicViewerUnsupported;
export const DELETE = publicViewerUnsupported;
export const OPTIONS = publicViewerUnsupported;
