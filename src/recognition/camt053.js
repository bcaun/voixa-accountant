// ISO 20022 camt.053 (BankToCustomerStatement) XML, offered by most EU banks.
import { XMLParser } from 'fast-xml-parser';

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => (v == null ? null : typeof v === 'object' ? (v['#text'] ?? null) : String(v));
const day = (d) => (d ? String(text(d?.Dt) || text(d?.DtTm) || '').slice(0, 10) || null : null);

export const looksLikeCamt053 = (s) => /BkToCstmrStmt/.test(s.slice(0, 5000));

export function parseCamt053(xml) {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false }).parse(xml);
  const stmts = arr(doc?.Document?.BkToCstmrStmt?.Stmt);
  if (!stmts.length) throw new Error('No statement (Stmt) element found');
  const s = stmts[0];
  const bal = (code) => {
    const b = arr(s.Bal).find((x) => text(x?.Tp?.CdOrPrtry?.Cd) === code);
    if (!b) return null;
    const v = Number(text(b.Amt));
    return text(b.CdtDbtInd) === 'DBIT' ? -v : v;
  };
  const transactions = [];
  for (const st of stmts) {
    for (const e of arr(st.Ntry)) {
      const sign = text(e.CdtDbtInd) === 'DBIT' ? -1 : 1;
      const details = arr(e.NtryDtls?.TxDtls);
      const parts = details.length ? details : [{}];
      for (const d of parts) {
        const amtNode = d.Amt ?? d.AmtDtls?.TxAmt?.Amt ?? e.Amt;
        const party = sign < 0 ? d.RltdPties?.Cdtr : d.RltdPties?.Dbtr;
        const partyNode = party?.Pty ?? party;
        const acct = sign < 0 ? d.RltdPties?.CdtrAcct : d.RltdPties?.DbtrAcct;
        const ustrd = arr(d.RmtInf?.Ustrd).map(text);
        const strd = arr(d.RmtInf?.Strd).flatMap((x) => [text(x?.CdtrRefInf?.Ref), ...arr(x?.RfrdDocInf).map((r) => text(r?.Nb))]);
        const orgId = arr(partyNode?.Id?.OrgId?.Othr).map((o) => text(o?.Id))[0] || null;
        transactions.push({
          booking_date: day(e.BookgDt), value_date: day(e.ValDt),
          amount: sign * Number(text(amtNode)), currency: amtNode?.['@Ccy'] || e.Amt?.['@Ccy'] || null,
          counterparty_name: text(partyNode?.Nm), counterparty_iban: text(acct?.Id?.IBAN), counterparty_tax_id: orgId,
          purpose: [...ustrd, ...strd, text(e.AddtlNtryInf)].filter(Boolean).join(' '),
          structured_refs: strd.filter(Boolean),
          bank_reference: text(d.Refs?.EndToEndId) && text(d.Refs?.EndToEndId) !== 'NOTPROVIDED' ? text(d.Refs.EndToEndId) : text(e.AcctSvcrRef),
        });
      }
    }
  }
  return {
    bank_name: text(s.Acct?.Svcr?.FinInstnId?.Nm) || text(s.Acct?.Svcr?.FinInstnId?.BICFI) || text(s.Acct?.Svcr?.FinInstnId?.BIC),
    account_holder: text(s.Acct?.Ownr?.Nm),
    iban: text(s.Acct?.Id?.IBAN),
    currency: text(s.Acct?.Ccy) || transactions[0]?.currency || null,
    period_start: String(text(s.FrToDt?.FrDtTm) || '').slice(0, 10) || null,
    period_end: String(text(stmts[stmts.length - 1].FrToDt?.ToDtTm) || '').slice(0, 10) || null,
    opening_balance: bal('OPBD') ?? bal('PRCD'),
    closing_balance: bal('CLBD'),
    transactions,
  };
}
