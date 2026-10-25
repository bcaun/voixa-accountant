// Reading PDFs, scans and photos of bank statements and invoices with Claude.
// Structured formats (Norma 43, camt.053, CSV) never come here; they are parsed
// exactly by code. The model only reads what is on the page: anything it cannot
// see is returned as null, and every value is validated before it is stored.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../config.js';

const str = z.string().nullable();
const num = z.number().nullable();

export const StatementSchema = z.object({
  is_bank_statement: z.boolean(),
  bank_name: str,
  account_holder: str,
  iban: str,
  currency: str,
  period_start: str,
  period_end: str,
  opening_balance: num,
  closing_balance: num,
  transactions: z.array(z.object({
    booking_date: str,
    value_date: str,
    amount: z.number(),
    currency: str,
    counterparty_name: str,
    counterparty_iban: str,
    counterparty_tax_id: str,
    purpose: z.string(),
    invoice_numbers: z.array(z.string()),
    contract_numbers: z.array(z.string()),
    bank_reference: str,
  })),
});

export const InvoiceSchema = z.object({
  is_invoice: z.boolean(),
  invoice_number: str,
  issue_date: str,
  due_date: str,
  issuer_name: str,
  issuer_tax_id: str,
  recipient_name: str,
  recipient_tax_id: str,
  currency: str,
  net_amount: num,
  tax_amount: num,
  total_amount: num,
  contract_number: str,
});

const SYSTEM = `You read financial documents for a Spanish accounting firm and return their contents as data.
Documents are usually in Spanish or English and come from Spanish banks and suppliers.
Report only what is printed in the document. When a value is not shown, return null; never estimate or fill in a value from context.
Dates are YYYY-MM-DD. Amounts are plain numbers with a dot as the decimal separator (1.234,56 € becomes 1234.56). Currency is the ISO code (EUR, USD, GBP).
Tax IDs are Spanish NIF/CIF/NIE or EU VAT numbers, without spaces. IBANs are without spaces.`;

const STATEMENT_TASK = `This file should be a bank account statement (extracto bancario).
Set is_bank_statement to false if it is not one, and return no transactions.
Otherwise list every movement in the order printed, across all pages. For each movement:
- amount: negative when money leaves the account (cargo, debe, adeudo, payment out), positive when it comes in (abono, haber).
- purpose: the full description text of the movement exactly as printed (concepto, referencias, remittance text), joined into one line.
- counterparty_name: the other party (beneficiary of a payment out, payer of a payment in) when the text names one; otherwise null.
- invoice_numbers: invoice numbers that appear in the movement text (after words like factura, fra, fact, invoice, inv, recibo), exactly as written. Empty when none.
- contract_numbers: contract, policy or agreement numbers that appear in the movement text (contrato, póliza, contract). Empty when none.
- counterparty_iban and counterparty_tax_id only when printed for that movement.
- bank_reference: the bank's own reference for the movement, when printed.
Include opening and closing balances and the statement period when printed.`;

const INVOICE_TASK = `This file should be an invoice (factura) or a receipt with an invoice number.
Set is_invoice to false if it is not one.
Otherwise return the invoice number exactly as printed, the issuer (who sells) and the recipient (who buys) with their tax IDs, the issue and due dates,
the currency, the taxable base (net_amount), the VAT or other tax (tax_amount) and the total payable (total_amount),
and a contract or order number if the invoice refers to one.`;

let client;
let override = null;
/** Tests replace the model call with a stub. */
export function setAiReader(fn) { override = fn; }

export const aiAvailable = () => !!override || (config.recognition.ai && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN));

const MEDIA = { pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/**
 * kind: 'statement' | 'invoice'. file: { type: 'pdf'|'png'|'jpeg'|'gif'|'webp'|'text', data: Buffer|string, name }
 */
export async function readWithAi(kind, file) {
  if (override) return override(kind, file);
  client ??= new Anthropic({ timeout: 15 * 60e3, maxRetries: 2 });
  const schema = kind === 'statement' ? StatementSchema : InvoiceSchema;
  const source = file.type === 'text'
    ? { type: 'text', text: `File name: ${file.name}\n\n${file.data}` }
    : file.type === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: MEDIA.pdf, data: file.data.toString('base64') } }
      : { type: 'image', source: { type: 'base64', media_type: MEDIA[file.type], data: file.data.toString('base64') } };
  const stream = client.beta.messages.stream({
    model: config.recognition.model,
    max_tokens: 64000,
    // on a safety decline the API retries the same request on a suitable fallback model
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: zodOutputFormat(schema) },
    system: SYSTEM,
    messages: [{ role: 'user', content: [source, { type: 'text', text: kind === 'statement' ? STATEMENT_TASK : INVOICE_TASK }] }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('The model declined to read this file');
  if (msg.stop_reason === 'max_tokens') throw new Error('The statement is too long to read in one go. Split it into shorter periods and upload again.');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error('The model returned data in an unexpected shape');
  return { data: parsed.data, model: msg.model };
}
