import { NextRequest, NextResponse } from 'next/server';
import { buildInvoiceXlsx, getInvoiceGeneratorStatus } from '@/app/invoice-generator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

type Params = {
  params: Promise<{
    invoiceId: string;
  }>;
};

export async function GET(_request: NextRequest, { params }: Params) {
  const { invoiceId } = await params;
  const id = Number(invoiceId);

  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'Nieprawidłowe ID faktury.' }, { status: 400 });
  }

  const status = await getInvoiceGeneratorStatus();
  const record = status.latestInvoices.find((item) => item.invoiceId === id);

  if (!record) {
    return NextResponse.json({ error: 'Nie znaleziono faktury w ostatnim statusie.' }, { status: 404 });
  }

  const file = buildInvoiceXlsx(record);
  const body = new Uint8Array(file);
  const safeInvoiceNumber = record.invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `faktura-${safeInvoiceNumber || id}.xlsx`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
