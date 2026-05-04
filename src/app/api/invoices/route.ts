import { NextRequest, NextResponse } from 'next/server';
import { getInvoiceGeneratorStatus, refreshInvoiceGeneratorStatus } from '@/app/invoice-generator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const forceRefresh = request.nextUrl.searchParams.get('forceRefresh') === 'true';
  const status = await getInvoiceGeneratorStatus({ forceRefresh });
  return NextResponse.json(status);
}

export async function POST() {
  const status = await refreshInvoiceGeneratorStatus();
  return NextResponse.json(status);
}
