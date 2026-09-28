import { nextSeq } from '@modules/counters/counter.service';
export async function nextInvoiceNumber(now = new Date()): Promise<string> {
  const year = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
  }).format(now);
  const seq = await nextSeq(`invoice:calendar:${year}`);
  return `INV/${year}/${String(seq).padStart(6, '0')}`;
}
