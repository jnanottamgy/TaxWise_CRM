import { NextResponse, type NextRequest } from "next/server";
import { logUnexpected } from "@/lib/log";
import { unexpectedMessage } from "@/lib/result";
import { todayIST } from "@/lib/domain/fy";
import { getFirmProfile } from "@/server/firm";
import { fullExportChunks, fullExportStream, parseCatalog } from "@/server/exports/full-export";
import { attachment, auditExport, gateExport, jsonResponse } from "@/server/reports/route-gate";

/**
 * GET /api/exports/full
 *
 * The full data export (§7.21 Settings → Data): a ZIP of CSV files, one for every table the Partner's
 * account can read, with the documents manifest and a README (server/exports/full-export.ts).
 * Partners only (§4.1), at two-step sign-in (§12). The tables and columns come from
 * full_export_catalog() (0214) and every row is read through the Partner's own session, so the
 * database's grants and RLS decide what the archive holds; the vault's ciphertext never leaves it.
 * The export_run audit row is written before the first byte. The archive is streamed as it is
 * built; an error part-way ends the download as failed rather than as a short archive. Errors
 * before the stream starts answer with the JSON contract and a Ref.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  let userId: string | null = null;
  try {
    const gate = await gateExport(["partner"], "Only Partners can export the firm's data.");
    if (!gate.ok) return gate.response;
    const { user, supabase } = gate;
    userId = user.id;

    const [{ data: rawCatalog, error }, firm] = await Promise.all([supabase.rpc("full_export_catalog"), getFirmProfile(supabase)]);
    if (error) throw error;
    const catalog = parseCatalog(rawCatalog);
    if (catalog.length === 0) return jsonResponse({ ok: false, error: "There is nothing this account can export.", code: "not_found" }, 404);

    await auditExport(supabase, request, {
      resourceType: "firm_data",
      resourceId: null,
      action: "settings.full_export",
      details: { tables: catalog.map((t) => t.name), format: "zip" },
    });

    const chunks = fullExportChunks(supabase, catalog, { firmName: firm.firmName, preparedBy: { name: user.fullName, email: user.email } });
    const stream = fullExportStream(chunks, (err) => {
      logUnexpected(err, { source: "api:exports:full:stream", userId });
    });

    return new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": attachment(`taxwise-full-export-${todayIST()}.zip`),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-TaxWise-Tables": String(catalog.length),
      },
    });
  } catch (err) {
    const ref = logUnexpected(err, { source: "api:exports:full", userId });
    return jsonResponse({ ok: false, error: unexpectedMessage(ref), ref }, 500);
  }
}
