/** Albanian rules summary of the Zhol house ruleset. */
export function Rules() {
  return (
    <div className="rules">
      <h3>Gurët</h3>
      <p>
        Loja ka 106 gurë: numrat 1–13 në katër ngjyra (e kuqe, e zezë, blu, e verdhë), nga dy kopje secili, plus dy gurë
        Zhol. Çdo ngjyrë ka edhe një shenjë: e kuqja një romb, e zeza një katror, bluja një rreth dhe e verdha një trekëndësh.
      </p>
      <p>
        Në fillim të çdo dore kthehet një gur tregues. Ai shërben vetëm për informacion dhe nuk luhet. Vetëm dy gurët Zhol
        janë gurë të lirë.
      </p>
      <h3>Lidhjet</h3>
      <ul>
        <li>
          <strong>Varg:</strong> 3 deri në 13 numra rresht me të njëjtën ngjyrë, p.sh. blu 1‑2‑3‑4. Pas 13 nuk vjen 1.
        </li>
        <li>
          <strong>Grup:</strong> 3 ose 4 gurë me të njëjtin numër dhe ngjyra të ndryshme, p.sh. 7 e kuqe, 7 blu, 7 e zezë. Dy
          gurë me të njëjtën ngjyrë nuk hyjnë në të njëjtin grup.
        </li>
        <li>
          <strong>Zhol:</strong> zë vendin e një guri që mungon në një varg ose grup. Dy Zhol mund të zënë dy vende të
          ndryshme.
        </li>
      </ul>
      <p>Rafti është vetëm yti. Renditja e gurëve nuk ndikon në rezultat.</p>
      <h3>Radha</h3>
      <p>
        Fillon lojtari me 15 gurë: ai vetëm hedh një gur. Pastaj, në drejtim të akrepave të orës, çdo lojtar tërheq një gur
        nga stoku ose merr gurin e fundit të hedhur nga lojtari para tij, dhe pastaj hedh një gur.
      </p>
      <h3>Mbyllja</h3>
      <p>
        Me 15 gurë në raft, zgjidh gurin që do hedhësh dhe shtyp «Mbyll raundin». Mbyllja vlen vetëm nëse të 14 gurët e
        mbetur ndahen të gjithë në vargje dhe grupe. Shtatë çifte nuk mbyllin. Një hedhje e zakonshme nuk e mbyll kurrë
        raundin vetvetiu.
      </p>
      <h3>Pikët</h3>
      <ul>
        <li>Kush mbyll merr −20 pikë.</li>
        <li>Kush mbyll duke hedhur një gur Zhol merr −40. Zhol-i i përdorur brenda lidhjeve nuk jep bonus.</li>
        <li>
          Të tjerët marrin pikët e gurëve që u mbeten pa lidhje, me renditjen më të mirë të mundshme: numri i shkruar mbi
          gur, 20 për një Zhol pa lidhje. P.sh. 5 e kuqe dhe 12 e zezë pa lidhje japin +17.
        </li>
        <li>Pas katër raundeve fiton kush ka më pak pikë. Nëse disa kanë të njëjtin rezultat më të ulët, fitojnë bashkë.</li>
      </ul>
      <h3>Dorë e bllokuar</h3>
      <p>
        Kush tërheq gurin e fundit të stokut mund të mbyllë ende. Nëse ai thjesht hedh një gur, dora bllokohet: gurët
        ndahen sërish për të njëjtin raund, me të njëjtin lojtar që fillon, dhe pikët nuk ndryshojnë.
      </p>
      <p>Fillimi kalon një vend në drejtim të akrepave pas çdo raundi të mbyllur, kështu çdo lojtar fillon një herë.</p>
    </div>
  );
}
