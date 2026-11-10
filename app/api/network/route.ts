import { NextResponse } from "next/server";
import { createDemoNetworkSnapshot } from "../../../src/lib/network/simulator";
export const dynamic = "force-dynamic";
export async function GET() {
  return NextResponse.json(createDemoNetworkSnapshot(), { headers: { "Cache-Control": "no-store" } });
}
