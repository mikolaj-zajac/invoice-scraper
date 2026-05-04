'use client';

import { useMemo, useState } from 'react';

type InvoiceShop = 'moto-tour' | 'defender' | 'unknown';

interface InvoiceRecord {
  invoiceId: number;
  invoiceUrl: string;
  invoiceNumber: string;
  shop: InvoiceShop;
  fetchedAt: string;
}

interface InvoiceGeneratorStatus {
  lastCheckedAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastCheckedInvoiceId: number | null;
  latestInvoices: InvoiceRecord[];
  note?: string;
}

interface InvoiceDashboardProps {
  initialStatus: InvoiceGeneratorStatus;
}

function formatDate(value: string | null): string {
  if (!value) return 'brak';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('pl-PL');
}

function getShopFromInvoiceNumber(invoiceNumber: string): string | null {
  if (/^MOTO\//i.test(invoiceNumber)) return 'moto-tour';
  if (/^DEF\//i.test(invoiceNumber)) return 'defender';
  return null;
}

export default function InvoiceDashboard({ initialStatus }: InvoiceDashboardProps) {
  const [status, setStatus] = useState<InvoiceGeneratorStatus | null>(initialStatus);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invoices = useMemo(() => status?.latestInvoices ?? [], [status]);

  const loadStatus = async (forceRefresh = false) => {
    setError(null);

    try {
      const response = await fetch(`/api/invoices?forceRefresh=${forceRefresh ? 'true' : 'false'}`, {
        method: 'GET',
      });

      if (!response.ok) {
        throw new Error(`Nie udało się pobrać statusu (${response.status})`);
      }

      const data = (await response.json()) as InvoiceGeneratorStatus;
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wystąpił nieznany błąd.');
    } finally {
      setLoading(false);
    }
  };

  const refreshNow = async () => {
    setRefreshing(true);
    setError(null);

    try {
      const response = await fetch('/api/invoices', { method: 'POST' });
      if (!response.ok) {
        throw new Error(`Odświeżenie zakończyło się błędem (${response.status})`);
      }

      const data = (await response.json()) as InvoiceGeneratorStatus;
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wystąpił nieznany błąd.');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6 sm:p-10">
      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-zinc-900">Generator faktur iDoSell</h1>
        <p className="mt-2 text-sm text-zinc-600">
          Panel uruchamia scraper i zapisuje ostatnie znalezione faktury. Dane logowania są trzymane tylko w zmiennych
          środowiskowych po stronie serwera.
        </p>

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void refreshNow()}
            disabled={refreshing}
            className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-400"
          >
            {refreshing ? 'Odświeżam...' : 'Odśwież teraz'}
          </button>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void loadStatus(false);
            }}
            disabled={loading}
            className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed"
          >
            Odśwież widok
          </button>
        </div>
      </section>

      {error ? (
        <section className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">Błąd: {error}</section>
      ) : null}

      <section className="grid gap-3 rounded-2xl border border-zinc-200 bg-white p-6 text-sm shadow-sm sm:grid-cols-3">
        <div>
          <p className="text-zinc-500">Ostatnie sprawdzenie</p>
          <p className="font-medium text-zinc-900">{formatDate(status?.lastCheckedAt ?? null)}</p>
        </div>
        <div>
          <p className="text-zinc-500">Ostatnie udane sprawdzenie</p>
          <p className="font-medium text-zinc-900">{formatDate(status?.lastSuccessfulCheckAt ?? null)}</p>
        </div>
        <div>
          <p className="text-zinc-500">Najwyższy sprawdzony ID</p>
          <p className="font-medium text-zinc-900">{status?.lastCheckedInvoiceId ?? 'brak'}</p>
        </div>
      </section>

      {status?.note ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{status.note}</section>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-zinc-900">Ostatnie faktury</h2>
        </div>

        {loading ? (
          <div className="p-6 text-sm text-zinc-500">Ładowanie...</div>
        ) : invoices.length === 0 ? (
          <div className="p-6 text-sm text-zinc-500">Brak faktur do wyświetlenia.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-zinc-50 text-left text-zinc-600">
                <tr>
                  <th className="px-4 py-3">ID</th>
                  <th className="px-4 py-3">Numer</th>
                  <th className="px-4 py-3">Sklep</th>
                  <th className="px-4 py-3">Pobrano</th>
                  <th className="px-4 py-3">Akcje</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.invoiceId} className="border-t border-zinc-100">
                    <td className="px-4 py-3 font-medium text-zinc-900">{invoice.invoiceId}</td>
                    <td className="px-4 py-3 text-zinc-700">{invoice.invoiceNumber}</td>
                    <td className="px-4 py-3 text-zinc-700">{getShopFromInvoiceNumber(invoice.invoiceNumber) || invoice.shop}</td>
                    <td className="px-4 py-3 text-zinc-700">{formatDate(invoice.fetchedAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-3">
                        <a
                          className="font-medium text-blue-700 hover:underline"
                          href={invoice.invoiceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Pobierz
                        </a>
                        <a
                          className="font-medium text-green-700 hover:underline"
                          href={`/api/invoices/${invoice.invoiceId}/xlsx`}
                        >
                          XLSX
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}