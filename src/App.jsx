import { useState, useEffect, useRef, useCallback } from "react";

// ── 설정 ─────────────────────────────────────────────────────────
// 프록시 서버 주소. 로컬 개발: http://localhost:3001
// 배포 시: 실제 서버 주소로 변경
const PROXY_BASE = "https://speedcam-server-production.up.railway.app";

// ── 공통 유틸 ─────────────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function warnLevel(d) { return d<150?"danger":d<400?"warning":d<800?"approach":"none"; }
function beep(ctx, f=880, d=0.12, v=0.4) {
  const o=ctx.createOscillator(), g=ctx.createGain();
  o.connect(g); g.connect(ctx.destination); o.frequency.value=f; o.type="sine";
  g.gain.setValueAtTime(v,ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+d);
  o.start(ctx.currentTime); o.stop(ctx.currentTime+d);
}

// ── 색상 팔레트 ───────────────────────────────────────────────────
const COL = {
  none:     {bg:"#080c10",ring:"#0d2030",card:"#0a1820",text:"#1a5070",glow:"transparent"},
  approach: {bg:"#060d00",ring:"#0d2200",card:"#0a1a00",text:"#4a8800",glow:"#4a880033"},
  warning:  {bg:"#0d0900",ring:"#221600",card:"#160f00",text:"#cc8800",glow:"#cc880033"},
  danger:   {bg:"#0d0000",ring:"#220000",card:"#160000",text:"#ee1111",glow:"#ee111133"},
};
const WMSG = {
  approach: ["📡","전방 단속카메라 감지"],
  warning:  ["⚠️","주의 — 카메라 접근 중"],
  danger:   ["🚨","위험 — 즉시 감속!"],
};
const SIDO_LIST = [
  "전체","서울특별시","부산광역시","대구광역시","인천광역시","광주광역시",
  "대전광역시","울산광역시","세종특별자치시","경기도","강원도","충청북도",
  "충청남도","전라북도","전라남도","경상북도","경상남도","제주특별자치도",
];

export default function App() {
  // ── state ────────────────────────────────────────────────────
  const [tab, setTab]           = useState(0);            // 0:모니터 1:DB설정 2:목록
  const [gps, setGps]           = useState("idle");       // idle|active|error
  const [pos, setPos]           = useState(null);
  const [spd, setSpd]           = useState(0);
  const [cameras, setCameras]   = useState([]);
  const [filter, setFilter]     = useState("전체");
  const [nearby, setNearby]     = useState([]);
  const [closest, setClosest]   = useState(null);
  const [warn, setWarn]         = useState("none");
  const [beepOn, setBeepOn]     = useState(true);

  // DB 설정 state
  const [apiKey, setApiKey]     = useState(() => localStorage.getItem("sg_key") || "");
  const [sido, setSido]         = useState("경상남도");
  const [sigungu, setSigungu]   = useState("");
  const [loading, setLoading]   = useState(false);
  const [loadMsg, setLoadMsg]   = useState("");
  const [progress, setProgress] = useState(0);  // 0~100
  const [svrStatus, setSvrStatus] = useState(null);

  const audioCtx  = useRef(null);
  const watchId   = useRef(null);
  const lastBeepT = useRef(0);

  // ── GPS ────────────────────────────────────────────────────
  const startGPS = useCallback(() => {
    if (!navigator.geolocation) { setGps("error"); return; }
    if (!audioCtx.current) audioCtx.current = new (window.AudioContext||window.webkitAudioContext)();
    setGps("active");
    watchId.current = navigator.geolocation.watchPosition(
      p => { setPos({lat:p.coords.latitude, lng:p.coords.longitude}); setSpd(p.coords.speed!=null?Math.round(p.coords.speed*3.6):0); },
      () => setGps("error"),
      {enableHighAccuracy:true, maximumAge:1000, timeout:10000},
    );
  }, []);

  const stopGPS = useCallback(() => {
    if (watchId.current) navigator.geolocation.clearWatch(watchId.current);
    setGps("idle"); setPos(null); setSpd(0); setNearby([]); setClosest(null); setWarn("none");
  }, []);

  // ── 위치 → 경고 계산 ───────────────────────────────────────
  useEffect(() => {
    if (!pos || cameras.length === 0) return;
    const pool = filter==="전체" ? cameras : cameras.filter(c=>c.type.includes(filter));
    const sorted = pool
      .map(c => ({...c, dist: Math.round(haversine(pos.lat, pos.lng, c.lat, c.lng))}))
      .sort((a,b) => a.dist-b.dist);
    setNearby(sorted.filter(c=>c.dist<1000));
    const cl = sorted[0]||null; setClosest(cl);
    const lv = warnLevel(cl?.dist??9999); setWarn(lv);
    if (beepOn && audioCtx.current && lv!=="none") {
      const now=Date.now(), gap=lv==="danger"?380:lv==="warning"?680:1400;
      if (now-lastBeepT.current>gap) { lastBeepT.current=now; beep(audioCtx.current, lv==="danger"?1300:lv==="warning"?880:660); }
    }
  }, [pos, cameras, filter, beepOn]);

  // ── 프록시 서버 상태 확인 ──────────────────────────────────
  const checkServer = async () => {
    try {
      const r = await fetch(`${PROXY_BASE}/api/status`, {signal: AbortSignal.timeout(3000)});
      const d = await r.json();
      setSvrStatus({ok:true, ...d});
    } catch {
      setSvrStatus({ok:false});
    }
  };
  useEffect(() => { checkServer(); }, []);

  // ── API로 카메라 전체 로드 ─────────────────────────────────
  const loadCameras = async () => {
    if (!apiKey.trim() && !svrStatus?.keyConfigured) {
      setLoadMsg("❌ API 키를 입력하거나 서버 .env에 키를 설정하세요."); return;
    }
    setLoading(true); setLoadMsg("서버에 요청 중…"); setProgress(5);

    const qs = new URLSearchParams();
    if (apiKey.trim()) qs.set("serviceKey", apiKey.trim());
    if (sido !== "전체") qs.set("ctprvnNm", sido);
    if (sigungu.trim()) qs.set("signguNm", sigungu.trim());

    try {
      // 1단계: 1페이지 먼저 → totalCount 파악
      qs.set("pageNo", "1"); qs.set("numOfRows", "1000");
      const r1 = await fetch(`${PROXY_BASE}/api/cameras?${qs}`);
      if (!r1.ok) { const e=await r1.json(); setLoadMsg(`❌ ${e.error}: ${e.detail||""}`); setLoading(false); return; }
      const d1 = await r1.json();
      const total = d1.totalCount || 0;
      const pages = Math.ceil(total/1000);
      setLoadMsg(`총 ${total}개 카메라 발견. 수집 중… (1/${pages}페이지)`);
      setProgress(20);

      let all = d1.items || [];
      localStorage.setItem("sg_key", apiKey);

      // 2단계: 나머지 페이지
      for (let p=2; p<=Math.min(pages,50); p++) {
        qs.set("pageNo", String(p));
        const rp = await fetch(`${PROXY_BASE}/api/cameras?${qs}`);
        if (!rp.ok) break;
        const dp = await rp.json();
        all = all.concat(dp.items||[]);
        setProgress(Math.round(20 + (p/pages)*75));
        setLoadMsg(`수집 중… (${p}/${pages}페이지, ${all.length}개)`);
      }

      // 좌표 유효성 필터
      const valid = all.filter(c => c.lat>30 && c.lat<40 && c.lng>124 && c.lng<132);
      setCameras(valid);
      setProgress(100);
      setLoadMsg(`✅ ${valid.length}개 카메라 로드 완료! (전체 ${total}개 중 좌표 유효)`);
    } catch(err) {
      setLoadMsg(`❌ 네트워크 오류: ${err.message}\n프록시 서버(${PROXY_BASE})가 실행 중인지 확인하세요.`);
    } finally { setLoading(false); }
  };

  // ── 스타일 ────────────────────────────────────────────────
  const c = COL[warn];
  const dotC = gps==="active"?"#00ee88":gps==="error"?"#ff4444":"#1a3050";

  const S = {
    app:    {minHeight:"100vh",background:c.bg,transition:"background 0.5s",display:"flex",flexDirection:"column",alignItems:"center",fontFamily:"'Courier New',monospace",color:"#8899aa",paddingBottom:48},
    tabBar: {display:"flex",width:"100%",maxWidth:420,borderBottom:"1px solid #0a1820"},
    tab:    a=>({flex:1,padding:"11px 0",background:"transparent",border:"none",borderBottom:a?`2px solid ${c.text}`:"2px solid transparent",color:a?c.text:"#1a3050",cursor:"pointer",fontSize:11,letterSpacing:2,textTransform:"uppercase"}),
    ring:   {marginTop:28,width:190,height:190,borderRadius:"50%",border:`2px solid ${c.ring}`,boxShadow:`0 0 50px ${c.glow},inset 0 0 30px rgba(0,0,0,0.6)`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",transition:"all 0.4s",position:"relative"},
    spd:    {fontSize:68,fontWeight:"bold",color:c.text,lineHeight:1,textShadow:`0 0 24px ${c.text}`,transition:"all 0.3s"},
    wbox:   {marginTop:20,width:"88%",maxWidth:370,padding:"14px 18px",border:`1px solid ${c.ring}`,borderRadius:6,background:c.card,textAlign:"center",transition:"all 0.3s"},
    row:    d=>({display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 12px",marginBottom:5,background:"#050c14",borderRadius:4,borderLeft:`3px solid ${d<150?"#ee1111":d<400?"#cc8800":d<800?"#4a8800":"#0d2030"}`}),
    btn:    (col="#1a4060",full)=>({padding:"10px "+(full?"0":"16px"),width:full?"100%":"auto",background:"transparent",border:`1px solid ${col}`,color:col,borderRadius:4,cursor:"pointer",fontSize:11,letterSpacing:2,textTransform:"uppercase",transition:"all 0.2s",boxSizing:"border-box"}),
    inp:    {width:"100%",background:"#050c14",border:"1px solid #0d2030",borderRadius:4,padding:"9px 11px",color:"#8899aa",fontSize:12,fontFamily:"inherit",boxSizing:"border-box",marginBottom:8},
    sel:    {width:"100%",background:"#050c14",border:"1px solid #0d2030",borderRadius:4,padding:"9px 11px",color:"#8899aa",fontSize:12,fontFamily:"inherit",boxSizing:"border-box",marginBottom:8},
    card:   {background:"#050c14",border:"1px solid #0d2030",borderRadius:6,padding:14,marginBottom:12},
    sec:    {fontSize:10,letterSpacing:3,color:"#1a3050",marginBottom:8,marginTop:16,textTransform:"uppercase"},
  };

  const filterTypes = ["전체","과속","신호","구간과속","불법주정차"];

  return (
    <div style={S.app}>
      <style>{`
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.2}}
        @keyframes flash{0%,100%{opacity:1}50%{opacity:.1}}
        .pdot{animation:pulse 1.8s infinite}
        .dflash{animation:flash .35s infinite}
        button:hover{opacity:.72;transform:scale(.98)}
        select option{background:#050c14}
        a{color:#2a7aaa}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:#050c14}
        ::-webkit-scrollbar-thumb{background:#0d2030}
      `}</style>

      {/* 헤더 */}
      <div style={{width:"100%",maxWidth:420,display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 18px",borderBottom:"1px solid #0a1820"}}>
        <div>
          <span style={{fontSize:12,letterSpacing:4,color:"#1a4060"}}>📷 SPEEDCAM GUARD</span>
          <div style={{fontSize:9,color:svrStatus?.ok?"#1a5030":"#5a1010",letterSpacing:2,marginTop:2}}>
            {svrStatus?.ok ? `▲ 프록시 ON · 캐시 ${svrStatus.cacheKeys}개` : "▼ 프록시 오프라인"}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:10,color:dotC}}>{gps==="active"?`DB ${cameras.length}개`:gps==="error"?"GPS오류":"대기"}</span>
          <div className={gps==="active"?"pdot":""} style={{width:7,height:7,borderRadius:"50%",background:dotC,boxShadow:gps==="active"?`0 0 8px ${dotC}`:"none"}}/>
        </div>
      </div>

      {/* 탭 */}
      <div style={S.tabBar}>{["모니터","DB 설정","목록"].map((t,i)=><button key={i} style={S.tab(tab===i)} onClick={()=>setTab(i)}>{t}</button>)}</div>

      {/* ══ 모니터 탭 ══ */}
      {tab===0&&<>
        <div style={S.ring} className={warn==="danger"?"dflash":""}>
          <div style={S.spd}>{gps==="active"?spd:"--"}</div>
          <div style={{fontSize:11,color:"#1a3050",letterSpacing:3}}>km/h</div>
          {gps==="active"&&cameras.length===0&&
            <div style={{position:"absolute",bottom:28,fontSize:9,color:"#cc8800",letterSpacing:1}}>DB 없음</div>}
        </div>

        {gps==="active"&&closest&&warn!=="none"
          ?<div style={S.wbox}>
            <div style={{fontSize:28}}>{WMSG[warn][0]}</div>
            <div style={{fontSize:10,letterSpacing:3,color:c.text,marginTop:4}}>{WMSG[warn][1]}</div>
            <div style={{fontSize:13,color:"#6688aa",marginTop:6}}>{closest.addr||`${closest.sido} ${closest.sigungu}`||"위치정보없음"}</div>
            {closest.type&&<div style={{fontSize:10,color:"#1a3050",marginTop:2}}>단속구분: {closest.type}</div>}
            <div style={{fontSize:34,fontWeight:"bold",color:c.text,textShadow:`0 0 14px ${c.text}`,marginTop:6}}>{closest.dist}m</div>
            {closest.limit>0&&<div style={{fontSize:12,color:"#1a3050",marginTop:2}}>제한속도 {closest.limit} km/h</div>}
          </div>
          :gps==="active"
            ?<div style={{...S.wbox,borderColor:"#0a1820"}}>
              <div style={{color:"#1a5030",fontSize:13}}>✅ 주변 단속카메라 없음</div>
              {closest&&<div style={{color:"#0d2030",fontSize:11,marginTop:3}}>최근접: {closest.dist}m</div>}
             </div>
            :<div style={{marginTop:40,textAlign:"center"}}>
              <div style={{fontSize:36,marginBottom:10}}>{gps==="error"?"⚠️":"📍"}</div>
              <div style={{color:"#1a3050",fontSize:13}}>{gps==="error"?"GPS 오류 또는 권한 거부":"GPS 시작 버튼을 누르세요"}</div>
              {cameras.length===0&&<div style={{color:"#0d1e2e",fontSize:11,marginTop:8}}>DB 탭에서 먼저 카메라 데이터 로드</div>}
             </div>}

        <div style={{display:"flex",gap:8,marginTop:20,width:"88%",maxWidth:370}}>
          {gps!=="active"
            ?<button style={{...S.btn("#00ee88"),flex:2}} onClick={startGPS}>▶ GPS 시작</button>
            :<button style={{...S.btn("#ff4444"),flex:2}} onClick={stopGPS}>■ 중지</button>}
          <button style={S.btn(beepOn?c.text:"#1a3050")} onClick={()=>{
            if(!audioCtx.current) audioCtx.current=new(window.AudioContext||window.webkitAudioContext)();
            setBeepOn(v=>!v);
          }}>{beepOn?"🔔":"🔕"}</button>
        </div>

        {cameras.length>0&&
          <div style={{display:"flex",gap:6,marginTop:12,flexWrap:"wrap",justifyContent:"center"}}>
            {filterTypes.map(t=>(
              <button key={t} style={{...S.btn(filter===t?c.text:"#1a3050"),padding:"5px 10px",fontSize:10}} onClick={()=>setFilter(t)}>{t}</button>
            ))}
          </div>}

        {gps==="active"&&nearby.length>0&&
          <div style={{width:"88%",maxWidth:370,marginTop:18}}>
            <div style={S.sec}>1km 이내 ({nearby.length}개)</div>
            {nearby.slice(0,6).map((cam,i)=>(
              <div key={i} style={S.row(cam.dist)}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,color:"#4a6880",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{cam.addr||`${cam.sido} ${cam.sigungu}`||"–"}</div>
                  <div style={{fontSize:10,color:"#1a3050"}}>{cam.type}{cam.limit>0?` · ${cam.limit}km/h`:""}</div>
                </div>
                <div style={{fontSize:18,fontWeight:"bold",color:cam.dist<150?"#ee1111":cam.dist<400?"#cc8800":"#3a7820",marginLeft:8}}>{cam.dist}m</div>
              </div>
            ))}
          </div>}
      </>}

      {/* ══ DB 설정 탭 ══ */}
      {tab===1&&<div style={{width:"88%",maxWidth:370,paddingTop:10}}>

        {/* 서버 상태 카드 */}
        <div style={S.sec}>프록시 서버 상태</div>
        <div style={{...S.card,borderColor:svrStatus?.ok?"#1a5030":"#5a1010"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:12,color:svrStatus?.ok?"#3a9a50":"#cc4444"}}>
                {svrStatus===null?"확인 중…":svrStatus.ok?"✅ 서버 온라인":"❌ 서버 오프라인"}
              </div>
              {svrStatus?.ok&&<div style={{fontSize:10,color:"#1a3050",marginTop:3}}>
                업타임 {svrStatus.uptime}초 · 캐시 {svrStatus.cacheKeys}개
              </div>}
              {svrStatus?.ok&&<div style={{fontSize:10,color:svrStatus.keyConfigured?"#1a5030":"#cc8800",marginTop:2}}>
                {svrStatus.keyConfigured?"🔑 서버에 API키 설정됨":"⚠️ 서버에 API키 없음 (아래에서 입력)"}
              </div>}
            </div>
            <button style={{...S.btn("#1a3050"),fontSize:10,padding:"6px 10px"}} onClick={checkServer}>새로고침</button>
          </div>
          {!svrStatus?.ok&&<div style={{marginTop:8,fontSize:11,color:"#5a1010",lineHeight:1.6}}>
            프록시 서버를 먼저 실행하세요:<br/>
            <code style={{color:"#cc8800",fontSize:10}}>cd server && npm install && npm start</code>
          </div>}
        </div>

        {/* API 키 */}
        <div style={S.sec}>공공데이터포털 API 키</div>
        <div style={S.card}>
          <div style={{fontSize:11,color:"#2a5070",lineHeight:1.8,marginBottom:8}}>
            1. <a href="https://www.data.go.kr/data/15028200/openapi.do" target="_blank" rel="noreferrer">공공데이터포털 → 전국무인교통단속카메라표준데이터</a> 오픈API 신청<br/>
            2. 승인 후 <strong style={{color:"#4a8888"}}>Decoding 키</strong> 복사<br/>
            3. 아래 입력 (또는 서버 <code style={{color:"#cc8800"}}>server/.env</code> 의 <code style={{color:"#cc8800"}}>DATA_GO_KR_KEY</code>에 설정)
          </div>
          <input style={S.inp} placeholder="공공데이터포털 서비스키 (Decoding)" value={apiKey}
            onChange={e=>{setApiKey(e.target.value); localStorage.setItem("sg_key",e.target.value);}}/>
          <div style={{fontSize:10,color:"#1a3050"}}>※ 키는 브라우저에 저장됩니다. 서버 .env에 설정 시 불필요합니다.</div>
        </div>

        {/* 지역 필터 */}
        <div style={S.sec}>데이터 범위 (선택)</div>
        <div style={S.card}>
          <div style={{fontSize:11,color:"#2a5070",marginBottom:8}}>전국 전체 로드 시 수만 건. 지역 필터 권장.</div>
          <select style={S.sel} value={sido} onChange={e=>setSido(e.target.value)}>
            {SIDO_LIST.map(s=><option key={s} value={s==="전체"?"":s}>{s}</option>)}
          </select>
          <input style={S.inp} placeholder="시군구명 (선택, 예: 창원시)" value={sigungu} onChange={e=>setSigungu(e.target.value)}/>
        </div>

        {/* 로드 버튼 */}
        <button style={{...S.btn(loading?"#1a3050":"#2a7aaa",true), marginBottom:8, opacity:loading?0.5:1}}
          onClick={loadCameras} disabled={loading}>
          {loading ? "🔄 로드 중…" : "📡 카메라 데이터 불러오기"}
        </button>

        {/* 진행바 */}
        {loading&&<div style={{width:"100%",height:4,background:"#0d2030",borderRadius:2,marginBottom:8,overflow:"hidden"}}>
          <div style={{height:"100%",width:`${progress}%`,background:c.text,transition:"width 0.3s",borderRadius:2}}/>
        </div>}

        {loadMsg&&<div style={{fontSize:11,color:loadMsg.startsWith("✅")?"#3a9a50":loadMsg.startsWith("❌")?"#cc4444":"#4a8888",whiteSpace:"pre-wrap",marginBottom:12,lineHeight:1.6}}>{loadMsg}</div>}

        {/* DB 현황 */}
        {cameras.length>0&&<>
          <div style={S.sec}>현재 DB 현황</div>
          <div style={S.card}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
              <span style={{fontSize:12,color:"#2a5070"}}>총 카메라</span>
              <span style={{fontSize:18,color:c.text,fontWeight:"bold"}}>{cameras.length.toLocaleString()}개</span>
            </div>
            {["과속","신호","구간과속","불법주정차"].map(t=>{
              const cnt=cameras.filter(x=>x.type.includes(t)).length;
              if(!cnt) return null;
              return <div key={t} style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:11,color:"#1a3050"}}>{t}</span>
                <span style={{fontSize:11,color:"#2a5070"}}>{cnt.toLocaleString()}개</span>
              </div>;
            })}
            <div style={{display:"flex",gap:8,marginTop:10}}>
              <button style={{...S.btn("#cc4444"),flex:1,fontSize:10}} onClick={()=>{setCameras([]);setLoadMsg("");setProgress(0);}}>🗑 초기화</button>
              <button style={{...S.btn("#1a3050"),flex:1,fontSize:10}} onClick={async()=>{
                await fetch(`${PROXY_BASE}/api/cache/clear`,{method:"POST"});
                setSvrStatus(s=>s?{...s,cacheKeys:0}:s);
              }}>♻️ 서버캐시 초기화</button>
            </div>
          </div>
        </>}
      </div>}

      {/* ══ 목록 탭 ══ */}
      {tab===2&&<div style={{width:"88%",maxWidth:370,paddingTop:10}}>
        <div style={S.sec}>등록된 카메라 ({cameras.length.toLocaleString()}개)</div>
        {cameras.length===0
          ?<div style={{textAlign:"center",color:"#1a3050",padding:30,fontSize:12}}>DB 탭에서 데이터를 먼저 로드하세요</div>
          :<>
            <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
              {filterTypes.map(t=>(
                <button key={t} style={{...S.btn(filter===t?c.text:"#1a3050"),padding:"5px 10px",fontSize:10}} onClick={()=>setFilter(t)}>{t}</button>
              ))}
            </div>
            <div style={{maxHeight:500,overflowY:"auto"}}>
              {(filter==="전체"?cameras:cameras.filter(x=>x.type.includes(filter))).slice(0,300).map((cam,i)=>(
                <div key={i} style={{...S.row(9999),marginBottom:4}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:11,color:"#4a6880",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{cam.addr||`${cam.sido} ${cam.sigungu}`||"좌표만 있음"}</div>
                    <div style={{fontSize:10,color:"#1a3050"}}>{cam.type}{cam.limit>0?` · ${cam.limit}km/h`:""}</div>
                  </div>
                  <div style={{fontSize:10,color:"#0d2030",marginLeft:8,textAlign:"right",flexShrink:0}}>
                    {cam.lat.toFixed(4)}<br/>{cam.lng.toFixed(4)}
                  </div>
                </div>
              ))}
              {cameras.length>300&&<div style={{textAlign:"center",color:"#1a3050",fontSize:10,padding:8}}>… 외 {(cameras.length-300).toLocaleString()}개</div>}
            </div>
          </>}
      </div>}
    </div>
  );
}
