import InvoiceDashboard from './invoice-dashboard';
import { getInvoiceGeneratorStatus } from './invoice-generator';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const initialStatus = await getInvoiceGeneratorStatus();

  return (
    <main className="min-h-screen bg-zinc-100">
      <InvoiceDashboard initialStatus={initialStatus} />
    </main>
  );
}
