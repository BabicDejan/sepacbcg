import React, { useEffect, useMemo, useRef, useState } from 'react'

/* ──────────────────────────────────────────────────────────────
   Konstante (demo trajanja + fiksno stanje)
   ────────────────────────────────────────────────────────────── */
const FIXED_START_BALANCE = 2000 // € – nije editabilno
const SEPA_INSTANT_DURATION = 2_000 // demo: ~2s
const SEPA_STANDARD_DURATION = 20_000 // demo: 1 dan ≈ 20s
const SWIFT_DEMO_DURATION = 40_000 // demo: 2 dana ≈ 40s

// SEPA naknade — indikativno:
function calcSepaFee(amount: number, channel: 'e-bankarstvo' | 'šalter', firstOfDay: boolean) {
  if (firstOfDay && amount <= 200) return 0.02
  if (channel === 'e-bankarstvo') return amount <= 20_000 ? 1.99 : 25
  return amount <= 20_000 ? 3.99 : 50
}

// Util
function formatEUR(n: number) {
  return new Intl.NumberFormat('me-ME', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(n)
}
function toAccCountry(country: string) {
  const s = (country || '').trim()
  if (s.length < 2) return s
  return s.slice(0, -1) + 'u'
}
function round2(n: number) { return Math.round(n * 100) / 100 }
function formatTime(ms: number) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (m < 60) return `${m} min ${sec}s`
  const h = Math.floor(m / 60)
  const min = m % 60
  if (h < 48) return `${h}h ${min}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/* ──────────────────────────────────────────────────────────────
   NEW: SEPA/EU pomoćne liste + IBAN alati (demo)
   ────────────────────────────────────────────────────────────── */
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  'Njemačka':'DE','Italija':'IT','Francuska':'FR','Španija':'ES','Hrvatska':'HR',
  'Slovenija':'SI','Austrija':'AT','Holandija':'NL','Švedska':'SE','Irska':'IE'
}

const SEPA_CODES = new Set([
  // EU + EEA (+ većina ostalih SEPA)
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE',
  'IS','LI','NO',
  // Ostale: UK, CH, AD, MC, SM, VA, AND 'ME' (CG) – demo
  'GB','CH','AD','MC','SM','VA','ME'
])
const EU_EEA_CODES = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE',
  'IS','LI','NO'
])
// zemalje sa dobrim SCT Inst pokrivanjem (demo)
const INSTANT_GOOD_COVERAGE = new Set(['DE','NL','ES','PT','FR','IT','SI','HR','AT','EE','LT','LV','BE','FI','SK','IE'])

// CG go-live za SEPA kreditne transfere (demo guard)
const CG_SEPA_GO_LIVE = new Date('2025-10-05')

// Lokalni korisnik u CG (za IBAN-diskriminaciju poruku)
const USER_HOME_COUNTRY = 'ME'

function getIbanCountry(ibanRaw: string): string | null {
  const iban = (ibanRaw || '').replace(/\s+/g, '').toUpperCase()
  const m = iban.match(/^([A-Z]{2})\d{2}[A-Z0-9]+$/)
  return m ? m[1] : null
}
function isSepaActiveFor(code: string) {
  if (!code) return false
  if (code === 'ME') return true  
  return SEPA_CODES.has(code)
}

/* ──────────────────────────────────────────────────────────────
   SWIFT profili – indikativno (CG tržište): banke + BEN/SHA/OUR
   ────────────────────────────────────────────────────────────── */
type SwiftCostOption = 'BEN' | 'SHA' | 'OUR'
type SwiftBank = 'Generic' | 'NLB' | 'CKB' | 'Hipotekarna'

const SWIFT_BANK_PROFILES: Record<
  SwiftBank,
  (amount: number, option: SwiftCostOption) => {
    senderFee: number
    correspondentFee: number
    note?: string
  }
> = {
  Generic: (amount, option) => {
    const base = amount <= 1_000 ? 10 : amount <= 20_000 ? 20 : 35
    const correspondent = option === 'OUR' ? 0 : 25
    const sender = base + (option === 'OUR' ? 25 : 0)
    return { senderFee: round2(sender), correspondentFee: round2(correspondent) }
  },
  NLB: (amount, option) => {
    const pct = option === 'BEN' ? 0.005 : option === 'SHA' ? 0.0075 : 0.01
    const min = option === 'BEN' ? 10 : option === 'SHA' ? 20 : 25
    const sender = Math.max(amount * pct, min)
    const correspondent = option === 'OUR' ? 0 : 25
    return {
      senderFee: round2(sender),
      correspondentFee: round2(correspondent),
      note: option === 'OUR' ? 'OUR pokriva troškove trećih banaka (indikativno do ~50€)' : undefined
    }
  },
  CKB: (amount, option) => {
    const base = Math.max(amount * 0.01, 9)
    const sender = option === 'OUR' ? base + 15 : base
    const correspondent = option === 'OUR' ? 0 : 25
    return { senderFee: round2(sender), correspondentFee: round2(correspondent) }
  },
  Hipotekarna: (amount, option) => {
    let base =
      amount <= 1_000 ? 10 :
      amount <= 5_000 ? 20 :
      amount <= 20_000 ? amount * 0.0035 :
      amount <= 100_000 ? amount * 0.003 : amount * 0.0025
    const sender = option === 'OUR' ? base + 25 : base
    const correspondent = option === 'OUR' ? 0 : 25
    return { senderFee: round2(sender), correspondentFee: round2(correspondent) }
  }
}

function calcSwiftFees(amount: number, bank: SwiftBank, option: SwiftCostOption) {
  const { senderFee, correspondentFee, note } = SWIFT_BANK_PROFILES[bank](amount, option)
  const beneficiaryGets = round2(amount - (option === 'OUR' ? 0 : correspondentFee))
  const senderPaysTotal = round2(amount + senderFee)
  return { senderFee, correspondentFee, beneficiaryGets, senderPaysTotal, note }
}

/* ──────────────────────────────────────────────────────────────
   NEW: SEPA checker logika (decision tree)
   ────────────────────────────────────────────────────────────── */
type SepaMethod = 'SCT'|'SCT_INST'|'SDD'|'NONE'
type SepaDecision = {
  eligible: boolean
  method: SepaMethod
  reasons: string[]
  warnings: string[]
}

function decideSepa({
  amount,
  payeeIban,
  countryName,
  wantsInstant,
  isSubscription,
}:{
  amount:number
  payeeIban:string
  countryName:string
  wantsInstant:boolean
  isSubscription:boolean
}): { decision: SepaDecision, payeeCode: string | null } {
  const reasons:string[] = []
  const warnings:string[] = []
  let method: SepaMethod = 'NONE'

  // valuta = EUR u ovoj aplikaciji
  if (amount <= 0) {
    return { decision: { eligible:false, method:'NONE', reasons:['Unesi iznos.'], warnings:[] }, payeeCode:null }
  }

  // odredi zemlju primaoca – IBAN prioritet, inače selektor
  const codeFromIban = getIbanCountry(payeeIban || '')
  const codeFromSelect = COUNTRY_NAME_TO_CODE[countryName] || null
  const payeeCode = codeFromIban || codeFromSelect

  if (!payeeCode) {
    reasons.push('Nedostaje zemlja primaoca (unesi IBAN ili izaberi destinaciju).')
    return { decision: { eligible:false, method:'NONE', reasons, warnings }, payeeCode }
  }

  // SEPA aktivnost (CG guard do go-live)
  if (!isSepaActiveFor(payeeCode)) {
    reasons.push('Banka primaoca nije u SEPA (još) ili nije aktivna.')
    return { decision: { eligible:false, method:'NONE', reasons, warnings }, payeeCode }
  }

  // Pretplata (SDD) ima poslovna ograničenja van EU/EEA
  if (isSubscription) {
    if (EU_EEA_CODES.has(payeeCode)) {
      method = wantsInstant ? 'SCT_INST' : 'SDD' // prikaži da je SDD primarni, ali dozvoli prikaz instant-a kao “želim odmah”
      reasons.push('Pretplata: SEPA Direct Debit (SDD) je moguć u EU/EEA.')
    } else {
      method = 'SCT'
      reasons.push('Pretplata traži SDD; van EU/EEA to može biti ograničeno.')
      warnings.push('Van EU/EEA trgovci često ne nude SDD – koristi SCT ili karticu.')
      if (USER_HOME_COUNTRY !== 'ME') { /* placeholder ako želiš dinamično */ }
    }
  } else {
    // Jednokratno plaćanje (SCT / SCT Inst)
    if (wantsInstant && INSTANT_GOOD_COVERAGE.has(payeeCode)) {
      method = 'SCT_INST'
      reasons.push('Obje strane tipično podržavaju SCT Inst (demo pretpostavka).')
    } else if (wantsInstant && !INSTANT_GOOD_COVERAGE.has(payeeCode)) {
      method = 'SCT'
      reasons.push('Instant nije svuda dostupan – koristi standardni SCT.')
    } else {
      method = 'SCT'
      reasons.push('Standardni SEPA kreditni transfer (SCT) je dostupan.')
    }
  }

  // IBAN diskriminacija – informativno
  if (!EU_EEA_CODES.has(USER_HOME_COUNTRY) && EU_EEA_CODES.has(payeeCode) && method === 'SDD') {
    warnings.push('SDD sa IBAN-om van EU/EEA (npr. ME) može biti odbijen iz poslovnih razloga.')
  }

const eligible: boolean = method !== ("NONE" as SepaMethod);

return {
  decision: { eligible, method, reasons, warnings },
  payeeCode,
};
}

/* ──────────────────────────────────────────────────────────────
   Glavna komponenta
   ────────────────────────────────────────────────────────────── */
export default function SepaSwiftSimulator() {
  // Fiksno stanje
  const [balance, setBalance] = useState<number>(FIXED_START_BALANCE)

  // Podesivi parametri (osim stanja)
  const [country, setCountry] = useState<string>('Njemačka')
  const [amountStr, setAmountStr] = useState<string>('250')
  const amount = useMemo(() => {
    if (amountStr.trim()==='') return 0
    const normalized = amountStr.replace(",", ".").replace(/^0+(?=\d)/, '')
    const n = Number(normalized)
    return Number.isFinite(n) ? n:0
  }, [amountStr])
  const [channel, setChannel] = useState<'e-bankarstvo' | 'šalter'>('e-bankarstvo')
  const [firstOfDay, setFirstOfDay] = useState<boolean>(true)
  const [useInstant, setUseInstant] = useState<boolean>(true)

  // NEW: dodatni ulazi za checker
  const [payeeIban, setPayeeIban] = useState<string>('')           // NEW
  const [isSubscription, setIsSubscription] = useState<boolean>(false) // NEW

  // SWIFT izbor
  const [swiftBank, setSwiftBank] = useState<SwiftBank>('Generic')
  const [swiftOption, setSwiftOption] = useState<SwiftCostOption>('SHA')

  // Sim stanje
  const [running, setRunning] = useState<boolean>(false)
  const [sepaProgress, setSepaProgress] = useState<number>(0)
  const [swiftProgress, setSwiftProgress] = useState<number>(0)
  const [finished, setFinished] = useState<{ sepa: boolean; swift: boolean }>({ sepa: false, swift: false })

  // Izračun naknada
  const sepaFee = useMemo(() => calcSepaFee(amount, channel, firstOfDay), [amount, channel, firstOfDay])

  const {
    senderFee: swiftSenderFeeCalc,
    correspondentFee: swiftCorrFee,
    beneficiaryGets: swiftBeneficiaryGets,
    senderPaysTotal: swiftSenderPaysTotal,
    note: swiftNote
  } = useMemo(() => calcSwiftFees(amount, swiftBank, swiftOption), [amount, swiftBank, swiftOption])

  // Trajanja
  const sepaDuration = useMemo(() => (useInstant ? SEPA_INSTANT_DURATION : SEPA_STANDARD_DURATION), [useInstant])
  const countryAcc = useMemo(() => toAccCountry(country), [country])
  const swiftDuration = SWIFT_DEMO_DURATION

  const timeSavedMs = useMemo(() => Math.max(swiftDuration - sepaDuration, 0), [sepaDuration, swiftDuration])

  // Realna ušteda: kolika je "efektivna cijena" da primalac dobije pun iznos
  const moneySaved = useMemo(() => {
  // Koliko košta da primalac dobije pun iznos kod SEPA
    const sepaEffectiveCost = amount + sepaFee // primalac dobija cijeli iznos

  // Koliko efektivno košta kod SWIFT-a
  // -> pošiljalac plati amount + senderFee, primalac dobije manje (swiftBeneficiaryGets)
    const swiftEffectiveCost = swiftSenderPaysTotal - swiftBeneficiaryGets + amount

  // Ušteda = razlika između SWIFT i SEPA effective cost
    return round2(Math.max(swiftEffectiveCost - sepaEffectiveCost, 0))
  }, [amount, sepaFee, swiftSenderPaysTotal, swiftBeneficiaryGets])


  const disabled = amount <= 0 || amount > balance || running

  // NEW: odluka checkera
  const { decision: sepaDecision, payeeCode } = useMemo(() => decideSepa({
    amount,
    payeeIban,
    countryName: country,
    wantsInstant: useInstant,
    isSubscription
  }), [amount, payeeIban, country, useInstant, isSubscription])

  // Tajmeri
  const sepaTimerRef = useRef<number | null>(null)
  const swiftTimerRef = useRef<number | null>(null)
  const sepaIntervalRef = useRef<number | null>(null);
  const swiftIntervalRef = useRef<number | null>(null);

  const sepaStartRef = useRef<number>(0)
  const swiftStartRef = useRef<number>(0)

  useEffect(() => {
    return () => {
      if (sepaIntervalRef.current) clearInterval(sepaIntervalRef.current);
      if (swiftIntervalRef.current) clearInterval(swiftIntervalRef.current);
      if (sepaTimerRef.current) cancelAnimationFrame(sepaTimerRef.current)
      if (swiftTimerRef.current) cancelAnimationFrame(swiftTimerRef.current)
    }
  }, [])

  const startSimulation = () => {
    if (disabled) return
    if (sepaIntervalRef.current) clearInterval(sepaIntervalRef.current);
    if (swiftIntervalRef.current) clearInterval(swiftIntervalRef.current)
    if (sepaTimerRef.current) cancelAnimationFrame(sepaTimerRef.current);
    if (swiftTimerRef.current) cancelAnimationFrame(swiftTimerRef.current);
    sepaTimerRef.current = null;
    swiftTimerRef.current = null;
    sepaIntervalRef.current = null;
    swiftIntervalRef.current = null;

    setRunning(true)
    setFinished({ sepa: false, swift: false })
    setSepaProgress(0)
    setSwiftProgress(0)

    setBalance((b) => round2(b - amount - sepaFee))

    // SEPA progress (interval)
    sepaStartRef.current = performance.now();
    sepaIntervalRef.current = window.setInterval(() => {
      const elapsed = performance.now() - sepaStartRef.current;
      const progress = Math.min((elapsed / sepaDuration) * 100, 100);
      setSepaProgress(progress);
      if (progress >= 100) {
        clearInterval(sepaIntervalRef.current!);
        sepaIntervalRef.current = null;
        setFinished(f => {
          const next = { ...f, sepa: true };
          if (next.swift) setRunning(false);
          return next;
        });
      }
    }, 100);

    // SWIFT progress (interval)
    swiftStartRef.current = performance.now();
    swiftIntervalRef.current = window.setInterval(() => {
      const elapsed = performance.now() - swiftStartRef.current;
      const progress = Math.min((elapsed / swiftDuration) * 100, 100);
      setSwiftProgress(progress);
      if (progress >= 100) {
        clearInterval(swiftIntervalRef.current!);
        swiftIntervalRef.current = null;
        setFinished(f => {
          const next = { ...f, swift: true };
          if (next.sepa) setRunning(false);
          return next;
        });
      }
    }, 100);
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-[#0b1f3b] to-[#113b7a] text-white px-4 py-8">
      <div className="max-w-7xl mx-auto">
        <Header balance={balance} />

        <div className="grid lg:grid-cols-2 gap-6 mt-6">
          {/* Lijevi panel – kontrole */}
          <div className="bg-white/10 backdrop-blur rounded-2xl p-6 shadow-xl border border-white/10">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/20">⚙️</span>
              Podesi simulaciju
            </h2>

            <div className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <Field label="Iznos za slanje">
                  <AmountInput value={amountStr} onChange={setAmountStr} />
                </Field>
                <Field label="Destinacija (SEPA zemlja)">
                  <Select
                    value={country}
                    onChange={setCountry}
                    options={[
                      'Njemačka','Italija','Francuska','Španija','Hrvatska',
                      'Slovenija','Austrija','Holandija','Švedska','Irska'
                    ]}
                  />
                </Field>
              </div>

              {/* NEW: IBAN primaoca (opciono) */}
              <Field label="IBAN primaoca (opciono)">
                <IbanInput value={payeeIban} onChange={setPayeeIban} />
              </Field>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <Field label="Kanal SEPA plaćanja">
                  <Segmented value={channel} onChange={(v) => setChannel(v as any)} options={['e-bankarstvo', 'šalter']} />
                </Field>
                <Field label="Prvi dnevni transfer do 200€?">
                  <Toggle value={firstOfDay} onChange={setFirstOfDay} />
                </Field>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <Field label="SEPA način">
                  <Segmented
                    value={useInstant ? 'SCT Inst (dostupno od 07/2026)' : 'SCT standard (do 1 dan)'}
                    onChange={(v) => setUseInstant(v.includes('Inst'))}
                    options={['SCT Inst (dostupno od 07/2026)', 'SCT standard (do 1 dan)']}
                  />
                </Field>
                {/* NEW: SDD preklopnik */}
                <Field label="Pretplata (SEPA Direct Debit)?">
                  <Toggle value={isSubscription} onChange={setIsSubscription} />
                </Field>
              </div>

              {/* SWIFT izbor banke i troškovne opcije */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <Field label="SWIFT banka (profil naknada)">
                  <Select
                    value={swiftBank}
                    onChange={(v) => setSwiftBank(v as SwiftBank)}
                    options={['Generic','NLB','CKB','Hipotekarna']}
                  />
                </Field>
                <Field label="SWIFT troškovna opcija">
                  <Segmented
                    value={swiftOption}
                    onChange={(v) => setSwiftOption(v as SwiftCostOption)}
                    options={['SHA','OUR','BEN']}
                  />
                </Field>
              </div>

              <div className="flex items-center justify-between pt-2">
                <div className="text-sm text-white/80 space-y-0.5">
                  <p>Stanje na računu: <b>{formatEUR(balance)}</b> (početno: {formatEUR(FIXED_START_BALANCE)})</p>
                  <p>SEPA naknada (indikativno): <b>{formatEUR(sepaFee)}</b></p>
                  <p>SWIFT pošiljalac ({swiftOption}): <b>{formatEUR(swiftSenderFeeCalc)}</b></p>
                  {swiftOption !== 'OUR' && (
                    <p>Procjena troškova posrednika/primaoca: <b>{formatEUR(swiftCorrFee)}</b></p>
                  )}
                </div>
                <button
                  onClick={startSimulation}
                  disabled={disabled}
                  className={
                    'rounded-xl px-5 py-3 font-semibold shadow-lg transition-all ' +
                    (disabled ? 'bg-white/20 text-white/60 cursor-not-allowed' : 'bg-white text-[#0b1f3b] hover:scale-[1.02]')
                  }
                >
                  🚀 Pošalji {formatEUR(amount)} u {countryAcc}
                </button>
              </div>

              {amount > balance && (
                <div className="text-rose-200 text-sm">Iznos je veći od stanja na računu.</div>
              )}
            </div>
          </div>

          {/* Desni panel – vizuelna simulacija */}
          <div className="space-y-6">
            {/* NEW: “Mogu li platiti SEPOM?” kartica */}
            <SepaEligibilityCard
              decision={sepaDecision}
              payeeCode={payeeCode}
              payeeIban={payeeIban}
            />

            <StatusCard
              title={useInstant ? 'SEPA Instant (SCT Inst)' : 'SEPA standard (SCT)'}
              subtitle={useInstant ? 'Demo: ≈2 sekunde – 24/7/365' : 'Demo: 1 dan ≈ 20 sekundi (grafički prikaz)'}
              colorFrom="#30cfd0"
              colorTo="#00ea9c"
              progress={sepaProgress}
              done={finished.sepa || sepaProgress >= 100}
              running={running}
            />

            <StatusCard
              title="SWIFT međunarodni transfer"
              subtitle="Demo: 2 dana ≈ 40 sekundi (grafički prikaz)"
              colorFrom="#9face6"
              colorTo="#74ebd5"
              progress={swiftProgress}
              done={finished.swift || swiftProgress >= 100}
              running={running}
            />

            <SummaryPanel
              amount={amount}
              sepaFee={sepaFee}
              swiftSenderFee={swiftSenderFeeCalc}
              swiftCorrFee={swiftCorrFee}
              swiftOption={swiftOption}
              swiftBeneficiaryGets={swiftBeneficiaryGets}
              swiftSenderPaysTotal={swiftSenderPaysTotal}
              timeSavedMs={timeSavedMs}
              moneySaved={moneySaved}
              balance={balance}
              country={country}
              useInstant={useInstant}
              note={swiftNote}
            />
          </div>
        </div>

        <Footnote />
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
   UI helpers
   ────────────────────────────────────────────────────────────── */
function Header({ balance }: { balance: number }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">SEPA vs SWIFT — interaktivni prikaz</h1>
        <p className="text-white/80 max-w-2xl mt-1">
          Vidi koliko <span className="font-semibold text-white">brže i jeftinije</span> mogu da prođu tvoja plaćanja
          u eurima kroz SEPA — u odnosu na klasični SWIFT.
        </p>
      </div>
      <div className="rounded-xl bg-white/10 px-4 py-2 text-sm ring-1 ring-white/20">
        Stanje: <span className="font-semibold">{formatEUR(balance)}</span>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-sm text-white/80">{label}</div>
      {children}
    </label>
  )
}

function AmountInput({ value, onChange }:{
  value: string; onChange: (s:string)=>void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2 ring-1 ring-inset ring-white/15 focus-within:ring-white/40">
      <span className="text-white/70">€</span>
      <input
        type="text"
        inputMode="decimal"
        placeholder="0"
        value={value}
        onChange={(e) => {
          const raw = e.target.value
          const cleaned = raw.replace(/[^\d.,]/g, '')
          onChange(cleaned)
        }}
        onBlur={(e) => {
          const normalized = e.target.value.replace(',', '.').replace(/^0+(?=\d)/, '')
          onChange(normalized)
        }}
        className="w-full bg-transparent outline-none placeholder-white/40"
      />
    </div>
  )
}

function Segmented({ value, onChange, options }:{
  value:string; onChange:(v:string)=>void; options:string[];
}) {
  return (
    <div className="flex rounded-xl bg-white/10 p-1 ring-1 ring-inset ring-white/15">
      {options.map((opt) => {
        const active = value === opt
        return (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            className={
              'flex-1 rounded-lg px-3 py-2 text-sm transition-all ' +
              (active ? 'bg-white text-[#0b1f3b] font-semibold' : 'text-white/80 hover:bg-white/5')
            }
          >
            {opt}
          </button>
        )
      })}
    </div>
  )
}

function Toggle({ value, onChange }:{ value:boolean; onChange:(v:boolean)=>void; }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={
        'relative inline-flex h-9 w-16 items-center rounded-full transition-colors ' +
        (value ? 'bg-white' : 'bg-white/20')
      }
    >
      <span
        className={
          'inline-block h-7 w-7 transform rounded-full bg-[#0b1f3b] transition-transform ' +
          (value ? 'translate-x-8' : 'translate-x-1')
        }
      />
      <span className="absolute -bottom-5 left-0 text-[10px] uppercase tracking-wide text-white/70">
        {value ? 'Da' : 'Ne'}
      </span>
    </button>
  )
}

function Select({ value, onChange, options }:{
  value:string; onChange:(v:string)=>void; options:string[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-xl bg-white/10 px-3 py-2 outline-none ring-1 ring-inset ring-white/15 focus:ring-white/40"
      >
        {options.map((o) => (
          <option key={o} value={o} className="bg-[#0b1f3b] text-white">
            {o}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-white/70">▾</span>
    </div>
  )
}

function StatusCard({ title, subtitle, colorFrom, colorTo, progress, done, running }:{
  title:string; subtitle:string; colorFrom:string; colorTo:string; progress:number; done:boolean;running:boolean
}) {
  const progressLabel = done ? 'Završeno' : (progress < 10 ? `${progress.toFixed(1)}%` : `${Math.round(progress)}%`)
  return (
    <div className="relative overflow-hidden rounded-2xl bg-white/10 p-6 shadow-xl ring-1 ring-white/10">
      <div
        className="pointer-events-none absolute -top-16 -right-16 h-48 w-48 rounded-full blur-3xl opacity-30"
        style={{ background: `linear-gradient(135deg, ${colorFrom}, ${colorTo})` }}
      />
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-white/80 text-sm">{subtitle}</p>
        </div>
        <span className="text-sm text-white/80">{progressLabel}</span>
      </div>
      <ProgressBar progress={progress} colorFrom={colorFrom} colorTo={colorTo} />
      <div className="mt-3 text-sm text-white/80">
        {running && (
          done ? (
            <div className="flex items-center gap-2 text-white">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white text-[#0b1f3b]">✓</span>
              Sredstva su dostupna primaocu.
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <PulseDot colorFrom={colorFrom} colorTo={colorTo} /> Obrada u toku…
            </div>
          )
        )}
      </div>
    </div>
  )
}

function ProgressBar({ progress, colorFrom, colorTo }:{
  progress:number; colorFrom:string; colorTo:string;
}) {
  const visible = progress > 0 && progress < 1 ? 1 : progress
  return (
    <div className="h-3 w-full overflow-hidden rounded-full bg-white/10">
      <div
        className="h-full rounded-full transition-[width] duration-150"
        style={{ width: `${visible}%`, background: `linear-gradient(90deg, ${colorFrom}, ${colorTo})` }}
      />
    </div>
  )
}

function PulseDot({ colorFrom, colorTo }:{ colorFrom:string; colorTo:string; }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ background: `linear-gradient(90deg, ${colorFrom}, ${colorTo})` }}
    />
  )
}

function SummaryPanel({
  amount, sepaFee,
  swiftSenderFee, swiftCorrFee, swiftOption, swiftBeneficiaryGets, swiftSenderPaysTotal,
  timeSavedMs, moneySaved, balance, country, useInstant, note
}:{
  amount:number; sepaFee:number;
  swiftSenderFee:number; swiftCorrFee:number; swiftOption:SwiftCostOption; swiftBeneficiaryGets:number; swiftSenderPaysTotal:number;
  timeSavedMs:number; moneySaved:number; balance:number; country:string; useInstant:boolean; note?:string;
}) {
  const timeSaved = formatTime(timeSavedMs)
  const sepaLabel = useInstant ? 'SEPA Inst' : 'SEPA (SCT)'
  return (
    <div className="rounded-2xl bg-white/10 p-6 ring-1 ring-white/10">
      <h4 className="text-lg font-semibold mb-3">Rezime</h4>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="rounded-xl bg-white/5 p-4">
          <StatRow label="Šalješ" value={`${formatEUR(amount)} → ${country}`} />
          <StatRow label={`${sepaLabel} naknada`} value={formatEUR(sepaFee)} />
          <div className="h-[1px] w-full bg-white/10 my-1" />
          <StatRow label={`SWIFT (${swiftOption}) – trošak pošiljaoca`} value={formatEUR(swiftSenderFee)} />
          {swiftOption !== 'OUR' && (
            <StatRow label="Trošak posrednika/primaoca (procjena)" value={formatEUR(swiftCorrFee)} />
          )}
          <StatRow label="Primaocu stiže (SWIFT)" value={formatEUR(swiftBeneficiaryGets)} />
          <StatRow label="Pošiljalac plaća ukupno (SWIFT)" value={formatEUR(swiftSenderPaysTotal)} />
          {note && <p className="text-xs text-white/70 mt-1 italic">* {note}</p>}
        </div>
        <div className="rounded-xl bg-white/5 p-4">
          <StatRow label="Ušteda novca (u odnosu na SWIFT)" value={formatEUR(moneySaved)} positive />
          <StatRow label="Ušteda vremena" value="Više od 1 dan" positive />
          <StatRow label="Novo stanje (prikaz)" value={formatEUR(balance)} />
        </div>
      </div>
      <p className="text-xs text-white/70 mt-3">
        * Sve brojke su indikativne za edukativni prikaz. Stvarne naknade zavise od banke, paketa i opcije BEN/SHA/OUR.
      </p>
    </div>
  )
}

function StatRow({ label, value, positive = false }:{ label:string; value:string; positive?:boolean; }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-white/80 text-sm">{label}</span>
      <span className={'font-semibold ' + (positive ? 'text-emerald-200' : 'text-white')}>{value}</span>
    </div>
  )
}

function Footnote() {
  return (
    <div className="mt-8 text-xs text-white/70 space-y-1">
      <p>SEPA Inst je edukativni prikaz; dostupnost i limiti zavise od banke. Standardni SCT se u praksi izvršava najkasnije sljedeći radni dan. U ovoj simulaciji: Inst ≈ 2s, 1 dan ≈ 20s.</p>
      <p>SWIFT transferi u praksi mogu potrajati više dana u zavisnosti od posrednika i zemlje. U ovoj simulaciji: 2 dana ≈ 40s.</p>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────
   NEW: UI za IBAN + SEPA eligibility kartica
   ────────────────────────────────────────────────────────────── */
function IbanInput({ value, onChange }:{ value:string; onChange:(v:string)=>void }) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2 ring-1 ring-inset ring-white/15 focus-within:ring-white/40">
      <span className="text-white/70">🏦</span>
      <input
        type="text"
        placeholder="npr. DE89 3704 0044 0532 0130 00"
        value={value}
        onChange={(e) => {
          const raw = e.target.value.toUpperCase()
          const cleaned = raw.replace(/[^A-Z0-9 ]/g, '')
          onChange(cleaned)
        }}
        className="w-full bg-transparent outline-none placeholder-white/40"
      />
      {value && (
        <span className="text-xs text-white/70">
          {getIbanCountry(value) || '—'}
        </span>
      )}
    </div>
  )
}

function SepaEligibilityCard({ decision, payeeCode, payeeIban }:{
  decision: SepaDecision
  payeeCode: string | null
  payeeIban: string
}) {
  const { eligible, method, reasons, warnings } = decision
  const badge = eligible ? (method === 'SCT_INST' ? '✅ SEPA Instant (SCT Inst)' :
                 method === 'SDD' ? '✅ SEPA Direct Debit (SDD)' :
                 method === 'SCT' ? '✅ SEPA kreditni transfer (SCT)' : '❌ Nije dostupno')
               : '❌ Nije dostupno'
  const sub = payeeCode ? `Primaoc: ${payeeCode}${payeeIban ? ' • IBAN detektovan' : ''}` : 'Primaoc: —'
  return (
    <div className="rounded-2xl bg-white/10 p-6 shadow-xl ring-1 ring-white/10">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Mogu li platiti SEPOM?</h3>
          <p className="text-sm text-white/80">{sub}</p>
        </div>
        <span className={
          'rounded-full text-sm px-3 py-1 ring-1 ' +
          (eligible ? 'bg-emerald-400/20 ring-emerald-300/40 text-emerald-100' : 'bg-rose-400/20 ring-rose-300/40 text-rose-100')
        }>
          {badge}
        </span>
      </div>

      <ul className="text-sm text-white/80 space-y-1">
        {reasons.map((r,i)=>(<li key={i}>• {r}</li>))}
      </ul>

      {warnings.length>0 && (
        <div className="mt-3 rounded-xl bg-amber-400/10 ring-1 ring-amber-300/30 p-3 text-amber-100 text-sm">
          <div className="font-semibold mb-1">Napomena</div>
          <ul className="space-y-1">
            {warnings.map((w,i)=>(<li key={i}>• {w}</li>))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-xs text-white/60">
        * Checker je edukativan. Instant i SDD zavise od podrške banaka i politike trgovca.
      </p>
    </div>
  )
}
