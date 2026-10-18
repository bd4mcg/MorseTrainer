import {BrowserSerial} from './web-serial.js?v=20261018-1';
import {nextPrompt,questionComplete,retentionMs,reviewReady,BANK_FILES,parsePracticeBank,parseCallsigns} from './practice-flow.js';
import {makeLesson,makeFreeLesson,Practice,checkTiming,CODES} from './morse.js?v=20261018-1';
const $=id=>document.getElementById(id),ms=n=>`${Math.round(n)} ms`,signed=n=>`${n>=0?'+':'−'}${Math.abs(Math.round(n))}`;
const SETTINGS_COOKIE='cw_trainer_settings';
const settingsDefaults={simulation:false,keyPin:'cts',keyPolarity:'high',rts:'high',wpm:'15',tolerance:'0.2',sound:true,autoReference:false,holdSeconds:'1.5',practiceType:'character',poolLetter:true,poolDigit:true,poolSymbol:false,zoom:'22'};
function validSettings(value){
 const result={...settingsDefaults};
 if(!value||typeof value!=='object')return result;
 for(const [id,choices] of Object.entries({keyPin:['cts','dsr','cd'],keyPolarity:['high','low'],rts:['high','low'],tolerance:['0.1','0.2','0.3'],practiceType:['character','word','callsign','qcode','cw','sentence','free']}))if(choices.includes(value[id]))result[id]=value[id];


 for(const [id,min,max] of [['wpm',5,40],['holdSeconds',0,30],['zoom',12,40]])if(value[id]!==''&&value[id]!=null&&Number.isFinite(Number(value[id]))&&Number(value[id])>=min&&Number(value[id])<=max)result[id]=String(value[id]);
 for(const id of ['simulation','sound','autoReference','poolLetter','poolDigit','poolSymbol'])if(typeof value[id]==='boolean')result[id]=value[id];
 if(!result.poolLetter&&!result.poolDigit&&!result.poolSymbol)result.poolLetter=true;
 return result;
}
function readSettings(){
 try{const entry=(document.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(SETTINGS_COOKIE+'='));return entry?validSettings(JSON.parse(decodeURIComponent(entry.slice(SETTINGS_COOKIE.length+1)))):null;}catch{return null;}
}
const savedSettings=readSettings();
function applySettings(values){
 for(const [id,value] of Object.entries(values)){
  if(id==='port'){
   if(value&&!$('port').querySelector(`option[value="${value}"]`))$('port').add(new Option(value,value));
   if(!value)continue;
  }
  if(typeof value==='boolean')$(id).checked=value;else $(id).value=value;
 }
}
function saveSettings(){
 const values=Object.fromEntries(Object.entries(settingsDefaults).map(([id,value])=>[id,typeof value==='boolean'?$(id).checked:$(id).value]));
 try{document.cookie=`${SETTINGS_COOKIE}=${encodeURIComponent(JSON.stringify(validSettings(values)))}; Max-Age=31536000; Path=/; SameSite=Strict`;$('cookieStatus').textContent=readSettings()?'设置已自动保存到 Cookie（有效期一年）。':'浏览器未保存 Cookie，请检查浏览器设置。';}catch{$('cookieStatus').textContent='无法保存 Cookie，请检查浏览器设置。';}
}
let banks={},selectedMode='character',callsigns=[],operation=0,stopping=false,checkingLevels=false,closingSettings=false;
let prompt=nextPrompt('character'),questionNumber=1,reviewAt=null,lastEdgeWall=0;
let lesson=makeLesson(prompt),practice=new Practice(lesson),running=false,source='com',connected=false,connecting=false,armed=false,token='',busy=false;
let rawDown=false,rawDash=false,outputDown=false,clock=null,inputOwner=null,serialOffset=null,held={key:false};
let audio=null,osc=null,gain=null,playing=false,automaticReference=false,playTimer=null,playResolve=null,playVersion=0,referenceGain=null,lastFrame=0,currentIndex=0;
function say(text){$('message').textContent=text;}
const tolerance=()=>Number($('tolerance').value);
const pools=()=>['poolLetter','poolDigit','poolSymbol'].filter(id=>$(id).checked).map(id=>$(id).value);
const holdSeconds=()=>retentionMs($('holdSeconds').value)/1000;
const captureTime=()=>performance.now();
function portLabel(){return $('port').value!==''?$('port').selectedOptions[0]?.textContent||'已授权串口':'未选择串口';}
function lock(){
 const frozen=running||playing||busy,simulation=$('simulation').checked;
 $('simulation').disabled=frozen||connected||connecting||closingSettings;
 $('openSettings').disabled=running||busy||connecting||stopping||closingSettings;
 $('checkLevels').disabled=simulation||running||playing||busy||connecting||closingSettings;
 $('checkLevels').textContent=checkingLevels&&connected?'停止电平检查':'电平检查';
 for(const id of ['port','keyPin','keyPolarity','rts','refreshPorts'])$(id).disabled=simulation||frozen||connected||connecting;
 $('wpm').disabled=frozen||connected||connecting;
 $('tolerance').disabled=frozen;
 $('practiceType').disabled=playing||busy;
 $('clear').disabled=playing||busy;
 for(const id of ['poolLetter','poolDigit','poolSymbol'])$(id).disabled=playing||busy;
 $('start').disabled=running||playing||busy||connecting;
 $('clearCookies').disabled=frozen||connected||connecting||stopping;
 $('finish').disabled=stopping||(!running&&!connecting&&!busy);
 $('listen').disabled=selectedMode==='free'||busy||connecting||stopping;
 $('guidedHint').hidden=selectedMode==='free';$('freeHint').hidden=selectedMode!=='free';
 $('clear').textContent=selectedMode==='free'?'↻ 清空记录':'↻ 换一题';
 $('listen').textContent=playing?'■ 停止标准码':'♫ 听本题标准码';
 $('keyboardPad').hidden=!running;
 $('connectionLight').classList.toggle('on',connected);
 $('connectionLabel').textContent=simulation?'模拟测试 · 无需串口':`${portLabel()} · ${connecting?'正在连接串口':connected?(armed?'输入就绪':'请松开电键'):'串口未连接'}`;
 $('keyboardHelp').textContent=simulation?'模拟测试：按住空格或下方按钮发报。':'练习中可按住空格或下方按钮发报，也可使用串口手键。';
 $('sourceBadge').textContent=simulation?(running?'模拟测试 · 空格拍发':'模拟测试 · 等待开始'):running?`${portLabel()} · 手键 / 空格`:connected?`${portLabel()} · 手键`:'等待开始练习';
}
function reset(){
 try{lesson=selectedMode==='free'?makeFreeLesson(Number($('wpm').value)):makeLesson(prompt,Number($('wpm').value));}catch(e){say(e.message);return false;}
 practice=new Practice(lesson,tolerance());clock=null;inputOwner=null;serialOffset=null;currentIndex=0;reviewAt=null;
 $('wpmValue').textContent=`${lesson.wpm} WPM`;$('screenSpeed').textContent=`${lesson.wpm} WPM`;
 $('dotMs').textContent=ms(lesson.unit);$('dashMs').textContent=ms(lesson.unit*3);$('letterMs').textContent=ms(lesson.unit*3);
 $('timelineScroll').scrollLeft=0;
 $('questionNumber').textContent=selectedMode==='free'?'自由练习':`第 ${questionNumber} 题`;
 render();return true;
}
async function ensureAudio(force=false){
 if(!force&&!$('sound').checked)return;
 if(!audio){audio=new AudioContext();osc=audio.createOscillator();gain=audio.createGain();osc.type='sine';osc.frequency.value=700;gain.gain.value=0;osc.connect(gain);gain.connect(audio.destination);osc.start();const referenceOsc=audio.createOscillator();referenceGain=audio.createGain();referenceOsc.frequency.value=700;referenceGain.gain.value=0;referenceOsc.connect(referenceGain);referenceGain.connect(audio.destination);referenceOsc.start();}
 await audio.resume();
}
function tone(down){if(!gain)return;const t=audio.currentTime;gain.gain.cancelScheduledValues(t);gain.gain.setTargetAtTime(down && $('sound').checked ? .14 : 0,t,.002);}
function edge(down,t){
 if(!running)return;
 lastEdgeWall=performance.now();
 if(reviewAt!==null){tone(false);return;}
 clock={t,wall:performance.now()};
 if(practice.edge(down,t)){tone(down);if(!down)render();}
 if(practice.marks.length>=200){finish();say('本轮达到 200 个信号，请清空后继续。');}
}
async function start(input='com'){
 if(running||playing||busy||connecting||$('settingsDialog').open||closingSettings)return;
 const request=++operation;source=input;busy=true;lock();
 try{
  void ensureAudio().catch(()=>say('无法播放侧音，将继续静音练习。'));
  if(request!==operation)return;
  if(input==='com'){
   if(connected)await api('/api/disconnect',{});
   if(request!==operation)return;
   connecting=true;lock();say('正在连接串口，请松开电键…');
   const state=await api('/api/connect',serialSettings());
   if(request!==operation)return;
   connected=state.connected;connecting=false;armed=state.armed||armed;
  }
  if(request!==operation)return;
  if(!reset())return;
  source=input;running=true;
  say(input==='keyboard'?'键盘练习已开始，按住空格或下方按钮发报。':input==='com'&&!armed?'串口已连接，请松开电键，随后即可开始发送。':'连续练习已开始，请发送本题。');
 }catch(e){if(request===operation){connecting=false;console.error('CW 开始练习失败',e);say(`无法开始练习：${e.message}（版本 20261018-1）`);}}
 finally{if(request===operation){busy=false;lock();autoListen();}}
}
async function finish(){
 if(stopping)return;stopping=true;
 ++operation;const closeSerial=source==='com'&&(connected||connecting||busy);
 reviewAt=null;running=false;stopReference();inputOwner=null;held={key:false};
 practice.finish();tone(false);$('keyButton').classList.remove('pressed');
 const s=practice.summary();render();
 say(`本轮结束：${s.good}/${s.total} 个点划长度及类型合格，${s.gapGood}/${s.gapTotal} 段字母或单词间距合格。`);
 busy=closeSerial;lock();
 try{if(closeSerial)await api('/api/disconnect',{});}
 catch(e){say(`停止练习后断开串口失败：${e.message}`);}
 finally{if(closeSerial){connected=false;connecting=false;armed=false;rawDown=false;rawDash=false;outputDown=false;}busy=false;stopping=false;lock();}
}
function keyInput(key,value){
 if(!running||held[key]===value)return;
 held[key]=value;
 if(key==='key')inputEdge('keyboard',value,performance.now());
 $('keyButton').classList.toggle('pressed',held.key);
}
function rect(x,y,w,h,fill,extra=''){return `<rect x="${x.toFixed(2)}" y="${y}" width="${Math.max(.8,w).toFixed(2)}" height="${h}" rx="2" fill="${fill}" ${extra}/>`;}
function timeline(now){
 const scale=Number($('zoom').value)/lesson.unit,pad=12;
 const live=practice.downAt!==null?{start:practice.downAt-practice.origin,end:now-practice.origin}:null;
 const last=live?.end??practice.marks.at(-1)?.end??0;
 const extent=Math.max(lesson.duration,last)+lesson.unit*2,width=Math.max(450,extent*scale+pad*2);
 const svg=$('timeline');svg.setAttribute('width',width);svg.setAttribute('viewBox',`0 0 ${width} 164`);
 let html='';const tick=lesson.unit*(extent/lesson.unit>180?10:5);
 for(let t=0;t<=extent;t+=tick){const x=pad+t*scale;html+=`<path d="M ${x} 26 V 131" stroke="#72a8b8" stroke-opacity=".45" stroke-dasharray="2 4"/><text x="${x}" y="150" fill="#497b8b" font-size="9">${Math.round(t)} ms</text>`;}
 lesson.letters.forEach(l=>{const x=pad+l.start*scale;html+=`<text x="${x}" y="17" fill="#315d67" font-size="12" font-weight="600">${l.char.replaceAll('&','&amp;')}</text>`;});
 lesson.marks.forEach((m,i)=>{const x=pad+m.start*scale;html+=rect(x,35,m.duration*scale,23,'#3d8868',`opacity="${i===currentIndex?1:.7}"`);if(i<lesson.marks.length-1&&m.gapKind!=='码内'){html+=`<path d="M ${x+m.duration*scale+2} 64 h ${m.gap*scale-4}" stroke="#538795" stroke-dasharray="3 2"/><text x="${x+m.duration*scale+4}" y="77" font-size="9" fill="#527d88">${m.gapKind} ${Math.round(m.gap)}</text>`;}});
 practice.gaps.filter(g=>g.kind!=='码内').forEach(g=>{const x=pad+g.start*scale;html+=`<path d="M ${x+2} 118 h ${Math.max(0,(g.end-g.start)*scale-4)}" stroke="${g.ok?'#607b89':'#b94f42'}" stroke-dasharray="3 2"/><text x="${x+3}" y="131" font-size="9" fill="${g.ok?'#527180':'#a03c34'}">${Math.round(g.actual)} ms</text>`;});
 practice.marks.forEach(m=>{html+=rect(pad+m.start*scale,88,m.actual*scale,23,m.ok&&m.correct?'#b455aa':'#b94f42');});
 if(live)html+=rect(pad+live.start*scale,88,Math.max(0,live.end-live.start)*scale,23,'#9953a7');
 if(last>0)html+=`<path d="M ${pad+last*scale} 28 V 114" stroke="#1f667b" stroke-width="1"/>`;
 svg.innerHTML=html;
 if(running){const box=$('timelineScroll'),cursor=pad+last*scale;if(cursor>box.scrollLeft+box.clientWidth-45)box.scrollLeft=Math.max(0,cursor-box.clientWidth+90);}
}
function render(){
 const now=captureTime(),marks=practice.marks,s=practice.summary();
 const live=practice.downAt!==null;
 currentIndex=live?marks.length:marks.length?marks.length-1:0;
 const expected=lesson.marks[currentIndex],last=marks.at(-1),currentLetter=expected?lesson.letters[expected.letter]:lesson.letters.at(-1);
 $('targetLetter').textContent=lesson.text;
 $('targetLetter').classList.toggle('word',lesson.letters.length>1);
 $('targetLabel').textContent=({character:'本题字符',word:'本题单词',callsign:'本题呼号',qcode:'本题 Q 简语',cw:'本题 CW 缩语',sentence:'本题通联句子',free:'无固定题目'})[selectedMode];
 const meaning=banks[selectedMode]?.[lesson.text];$('promptMeaning').textContent=meaning||'';$('promptMeaning').hidden=!meaning;
 $('targetCode').textContent=selectedMode==='free'?'点 1 · 划 3 · 码内 1 · 字母 3 · 单词 7':lesson.letters.map(l=>l.code.replaceAll('.','·').replaceAll('-','−')).join(' / ');
 const received=practice.received(now,true);const decoded=received.at(-1)||'—';
 $('receivedLetter').textContent=received.length?received.map(c=>(c===' '||CODES[c])?c:'…').join(''):'—';
 $('receivedLetter').classList.toggle('word',lesson.letters.length>1||received.length>1);
 $('receivedCode').textContent=decoded==='—'?'等待发报':received.slice(-12).map(c=>c===' '?' / ':c).join(' ');
 $('screenPosition').textContent=selectedMode==='free'?`已发 ${marks.length} 个点划 · 标准条按实发起点对齐`:`第 ${currentLetter.index+1} / ${lesson.letters.length} 个字母`;
 const duration=live?Math.max(0,now-practice.downAt):last?.actual;
 const e=selectedMode==='free'&&live?{symbol:duration<2*lesson.unit?'.':'-',duration:(duration<2*lesson.unit?1:3)*lesson.unit}:live?lesson.marks[marks.length]:last?.expected??lesson.marks[0];
 $('currentLabel').textContent=`${live?'发送中':last?'刚完成':'下一个'} · ${e?(e.symbol==='.'?'点':'划'):selectedMode==='free'?'等待拍发':'额外信号'}`;
 $('currentDuration').innerHTML=`${duration===undefined?'—':Math.round(duration)} <em>ms</em>`;
 $('currentTarget').textContent=e?`标准 ${ms(e.duration)}`:selectedMode==='free'?`点 ${ms(lesson.unit)} / 划 ${ms(lesson.unit*3)}`:'无对应标准';
 const check=duration===undefined?null:checkTiming(duration,e?.duration,tolerance());
 $('currentError').textContent=check?.error==null?'—':`${signed(check.error*100)}%`;
 $('currentError').className=check&&!live?(check.ok?'good':'bad'):'';
 $('currentVerdict').textContent=!check?'松键后判定':check.target===null?'额外信号':live?(check.error>tolerance()?'已超长，等待松键':'实时计时，松键后判定'):`${check.label} · ${signed(check.delta)} ms${last&&!last.correct?' · 点划类型不符':''}`;
 const gap=practice.gaps.at(-1),prev=lesson.marks[marks.length-1];
 const gapLive=selectedMode!=='free'&&running&&!live&&practice.lastEnd!==null&&marks.length<lesson.marks.length;
 $('gapLabel').textContent=gapLive?`${prev?.gapKind??'前'}间距 · 等待下一次按下`:gap?`${gap.kind}间距 · 已测`:'字母间距';
 $('gapDuration').innerHTML=`${gapLive?Math.round(now-practice.lastEnd):gap?Math.round(gap.actual):'—'} <em>ms</em>`;
 $('gapDuration').className=gapLive?'':gap?(gap.ok?'good':'bad'):'';
 $('gapVerdict').textContent=gapLive?`标准 ${ms(prev?.gap??lesson.unit*3)} · 进行中，不评分`:gap?`${gap.label} · 标准 ${gap.target===null?'—':ms(gap.target)}${gap.delta===null?'':` / ${signed(gap.delta)} ms`}`:`标准 ${ms(lesson.unit*3)} · 下一次按下后判定`;
 $('markScore').textContent=marks.length?`${Math.round(s.good/s.total*100)}%`:'—';$('markCount').textContent=selectedMode==='free'?`${s.total} 个点划 · ${s.good} 个长度合格`:`${s.total} / ${s.expected} 个点划 · ${s.good} 个合格`;
 $('gapScore').textContent=s.gapTotal?`${Math.round(s.gapGood/s.gapTotal*100)}%`:'—';$('gapCount').textContent=s.gapTotal?`${s.gapGood} / ${s.gapTotal} 段间距合格`:'尚未测到字母间距';
 const dots=marks.filter(m=>m.expected?.symbol==='.'),dashes=marks.filter(m=>m.expected?.symbol==='-'),mean=a=>a.reduce((n,m)=>n+m.actual,0)/a.length;
 $('ratio').textContent=dots.length&&dashes.length?`1 : ${(mean(dashes)/mean(dots)).toFixed(2)}`:'— : —';
 $('completion').textContent=selectedMode==='free'?'按实测长度归类，不能判断原本想发的字符':practice.finished?`本轮结束 · 未发 ${s.missing} · 多发 ${s.extra}`:running?'正在记录电键通断':'按目标顺序对照';
 $('details').innerHTML=marks.length?marks.map((m,i)=>{const g=i?practice.gaps[i-1]:null;return `<tr><td>${i+1} / ${m.expected?.char??'额外'} ${m.expected?(m.expected.symbol==='.'?'·':'−'):''}</td><td>${ms(m.actual)} / ${m.target===null?'—':ms(m.target)}</td><td class="${m.ok?'good':'bad'}">${m.delta===null?'—':`${signed(m.delta)} ms / ${signed(m.error*100)}%`}</td><td class="${g&&!g.ok?'bad':''}">${g?`${ms(g.actual)} / ${g.target===null?'—':ms(g.target)}`:'—'}${g?`<small>${g.kind}间距 · ${g.label}</small>`:''}</td><td class="${m.ok&&m.correct?'good':'bad'}">${m.target===null?'额外信号':`${m.label}${!m.correct?' · 类型不符':''}`}</td></tr>`;}).reverse().join(''):'<tr><td colspan="5" class="empty">每次松键后，显示点划长度；下一次按下后，显示间隔长度。</td></tr>';
 timeline(now);
}
const serial=new BrowserSerial({emit:handleSerialPacket});
async function api(path,data){
 if(path==='/api/connect'){
  const state=await serial.connect(data);await refreshPorts();return state;
 }
 if(path==='/api/disconnect')return serial.disconnect();
 throw new Error('未知操作');
}
async function refreshPorts(){
 $('refreshPorts').disabled=true;
 try{const ports=await serial.list(),previous=$('port').value;$('port').replaceChildren(new Option('选择其它串口…',''));for(const p of ports)$('port').add(new Option(p.label,p.id));$('port').value=serial.port?String(serial.ports.indexOf(serial.port)):ports.some(p=>p.id===previous)?previous:ports[0]?.id||'';}
 catch(e){if(!$('simulation').checked)say(e.message);}finally{lock();}
}
function inputEdge(device,down,t){
 if(!running||automaticReference)return;
 if(down){if(inputOwner!==null)return;inputOwner=device;}
 else {if(inputOwner!==device)return;inputOwner=null;}
 edge(down,Math.max(t,practice.lastTime));
}
function serialEdge(down,t){
 outputDown=down;
 if(!running)return;
 if(serialOffset===null)serialOffset=performance.now()-t;
 if(down&&inputOwner===null&&t+serialOffset<practice.lastTime)serialOffset=performance.now()-t;
 inputEdge('serial',down,t+serialOffset);
}
function stopReference(){
 ++playVersion;clearTimeout(playTimer);playTimer=null;
 if(referenceGain){referenceGain.gain.cancelScheduledValues(audio.currentTime);referenceGain.gain.setValueAtTime(0,audio.currentTime);}
 const wasAutomatic=automaticReference;automaticReference=false;playing=false;if(wasAutomatic&&running)say(inputsReleased()?'标准码播放结束，请开始拍发。':'标准码播放结束，请先松开电键或空格，再开始拍发。');const resolve=playResolve;playResolve=null;resolve?.();lock();
}
function autoListen(){if(selectedMode!=='free'&&running&&$('autoReference').checked&&!playing&&!busy)void listen(true);}
async function listen(automatic=false){
 if(selectedMode==='free')return;
 if(playing){stopReference();return;}
 const version=++playVersion;playing=true;automaticReference=automatic===true;lock();
 try{
  await ensureAudio(true);if(version!==playVersion)return;
  const start=audio.currentTime+.12;
  for(const m of lesson.marks){const t=start+m.start/1000,end=t+m.duration/1000;referenceGain.gain.setValueAtTime(0,t);referenceGain.gain.linearRampToValueAtTime(.14,t+.002);referenceGain.gain.setValueAtTime(.14,end-.002);referenceGain.gain.linearRampToValueAtTime(0,end);}
  say(automaticReference?'先听本题标准码，播放结束后开始拍发。':'正在播放本题标准码，已发记录保留。');
  await new Promise(resolve=>{playResolve=resolve;playTimer=setTimeout(resolve,lesson.duration+300);});
 }catch(e){say(`无法播放标准码：${e.message}`);}finally{if(version===playVersion)stopReference();}
}
function inputsReleased(){return !(rawDown||rawDash||outputDown||held.key||inputOwner);}
function changeQuestion(){
 if(!inputsReleased()||practice.downAt!==null){say('请先松开电键，等当前点划结束后换题。');return false;}
 try{prompt=$('practiceType').value==='free'?'':nextPrompt($('practiceType').value,prompt,Math.random,pools(),callsigns,banks);}catch(e){if(running)finish();say(e.message);return false;}selectedMode=$('practiceType').value;questionNumber++;reset();
 say(selectedMode==='free'?'自由拍发：无固定题目，不自动清空；按长度归类点划并检查节奏。最多记录 200 个点划，可随时松键后清空。':running?'新题已就绪，请继续发送。':'已随机出题，点击开始练习。');lock();autoListen();return true;
}
function checkAdvance(){
 if(selectedMode==='free'||!running||playing||busy)return;
 if(reviewAt===null&&questionComplete(practice,captureTime())&&inputsReleased()){
  practice.finish();reviewAt=performance.now();tone(false);render();
  const s=practice.summary();
  say(`本题 ${lesson.text} 完成：${s.good}/${s.total} 个点划合格，${s.gapGood}/${s.gapTotal} 段字母间距合格。即将自动换题。`);
 }
 if(reviewAt!==null){
  if(reviewReady({reviewAt,now:performance.now(),holdSeconds:holdSeconds(),lastEdgeAt:lastEdgeWall,unit:lesson.unit,released:inputsReleased()}))changeQuestion();
 }
}
$('holdSeconds').onchange=()=>{$('holdSeconds').value=holdSeconds();};
for(const id of ['poolLetter','poolDigit','poolSymbol'])$(id).onchange=()=>{
 if(!pools().length){$(id).checked=true;say('请至少保留一种出题范围。');return;}
 if(!inputsReleased()||practice.downAt!==null){$(id).checked=!$(id).checked;say('请先松开电键再修改出题范围。');return;}
 if($('practiceType').value==='character')changeQuestion();
};
function practiceModeUI(){
 $('characterPools').hidden=$('practiceType').value!=='character';
 $('callsignControls').hidden=$('practiceType').value!=='callsign';
}
async function loadCallsigns(){
 const response=await fetch('./callsign.txt',{cache:'no-store'});if(!response.ok)throw new Error('无法读取 callsign.txt');const data=parseCallsigns(await response.text());callsigns=data.callsigns;
 $('callsignStatus').textContent=`callsign.txt · ${callsigns.length} 个呼号${data.invalid.length?` · 跳过 ${data.invalid.length} 行无效内容`:''}`;
 if(!callsigns.length)throw new Error('callsign.txt 尚无有效呼号。请每行填写一个呼号（字母、数字或 /），保存后重新读取。');
}
async function loadPracticeBank(mode){
 const file=BANK_FILES[mode];
 const response=await fetch('./'+file,{cache:'no-store'});
 if(!response.ok)throw new Error(`无法读取 ${file}，请确认文件位于程序目录中。`);
 try{banks[mode]=parsePracticeBank(await response.text());}catch(e){throw new Error(`${file}：${e.message}`);}
}
$('practiceType').onchange=async()=>{
 if(!inputsReleased()||practice.downAt!==null){$('practiceType').value=selectedMode;say('请先松开电键再切换模式。');return;}
 if($('practiceType').value==='callsign'||BANK_FILES[$('practiceType').value]){
  busy=true;lock();try{if($('practiceType').value==='callsign')await loadCallsigns();else await loadPracticeBank($('practiceType').value);}catch(e){$('practiceType').value=selectedMode;say(e.message);practiceModeUI();return;}finally{busy=false;lock();}
 }
 if(!changeQuestion())$('practiceType').value=selectedMode;practiceModeUI();
};
$('reloadCallsigns').onclick=async()=>{
 if(running||playing||busy){say('请先停止练习，再重新读取呼号文件。');return;}
 busy=true;lock();try{await loadCallsigns();changeQuestion();}catch(e){say(e.message);}finally{busy=false;lock();}
};
function serialSettings(){return {port:$('port').value,mode:'straight',keyPin:$('keyPin').value,dashPin:'dsr',keyLow:$('keyPolarity').value==='low',dashLow:false,rtsHigh:$('rts').value==='high',wpm:Number($('wpm').value)};}
function clearSerialState(){
 connected=false;connecting=false;armed=false;rawDown=false;rawDash=false;outputDown=false;
 for(const id of ['pinCts','pinDsr','pinCd']){$(id).className='';$(id).querySelector('b').textContent='—';}
}
async function stopLevelCheck(){
 ++operation;
 if(checkingLevels||connected||connecting){await api('/api/disconnect',{});clearSerialState();}
 checkingLevels=false;
}
async function closeSettings(){
 if(closingSettings)return;
 closingSettings=true;busy=true;lock();
 try{await stopLevelCheck();$('levelCheckStatus').textContent='电平检查已停止，串口已断开。';$('settingsDialog').close();}
 catch(e){$('levelCheckStatus').textContent=`断开失败：${e.message}，请重试关闭设置。`;}
 finally{closingSettings=false;busy=false;lock();}
}
$('checkLevels').onclick=async()=>{
 if($('simulation').checked||running||playing||busy||connecting||closingSettings||!$('settingsDialog').open)return;
 busy=true;lock();
 if(checkingLevels&&connected){
  try{await stopLevelCheck();$('levelCheckStatus').textContent='已停止检查，可修改串口参数。';}catch(e){$('levelCheckStatus').textContent=e.message;}finally{busy=false;lock();}return;
 }
 const request=++operation;checkingLevels=true;
 try{
  if(connected)await api('/api/disconnect',{});
  if(request!==operation)return;
  connecting=true;lock();$('levelCheckStatus').textContent='正在连接串口…';
  const state=await api('/api/connect',serialSettings());
  if(request!==operation)return;
  connected=state.connected;connecting=false;armed=state.armed||armed;
  $('levelCheckStatus').textContent='已连接，请按下、松开电键，观察 CTS / DSR / DCD 的高低电平变化。退出设置会自动断开。';
 }catch(e){if(request===operation){checkingLevels=false;connecting=false;$('levelCheckStatus').textContent=`电平检查失败：${e.message}`;}}
 finally{if(request===operation){busy=false;lock();}}
};
$('openSettings').onclick=()=>{
 if(running||busy||connecting||stopping||closingSettings)return;
 $('settingsDialog').showModal();
};
$('closeSettings').onclick=closeSettings;
$('settingsDialog').oncancel=e=>{e.preventDefault();return closeSettings();};
$('settingsDialog').onclose=()=>{if(!closingSettings&&(checkingLevels||connected||connecting))return closeSettings();};
practiceModeUI();
for(const id of ['wpm','tolerance'])$(id).addEventListener('input',reset);
$('clear').onclick=changeQuestion;$('listen').onclick=()=>listen();
$('sound').onchange=()=>{tone(false);if($('sound').checked)ensureAudio().catch(e=>say(e.message));};
for(const [id,key] of [['keyButton','key']]){
 $(id).onpointerdown=e=>{e.preventDefault();$(id).setPointerCapture(e.pointerId);keyInput(key,true);};
 $(id).onpointerup=()=>keyInput(key,false);$(id).onpointercancel=()=>keyInput(key,false);$(id).onlostpointercapture=()=>keyInput(key,false);
}
const keyMap={Space:'key'};
window.addEventListener('keydown',e=>{if(!running||$('settingsDialog').open||e.target.isContentEditable||/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)||!keyMap[e.code])return;e.preventDefault();if(!e.repeat)keyInput(keyMap[e.code],true);});
window.addEventListener('keyup',e=>{if(keyMap[e.code]&&held.key){e.preventDefault();keyInput(keyMap[e.code],false);}});
window.addEventListener('blur',()=>{if(held.key)keyInput('key',false);});
$('simulation').onchange=()=>{lock();say($('simulation').checked?'模拟测试已开启，点击开始练习后用空格拍发。':'模拟测试已关闭，开始练习时连接串口。');};
$('port').onchange=lock;$('zoom').oninput=render;
$('refreshPorts').onclick=refreshPorts;$('start').onclick=()=>start($('simulation').checked?'keyboard':'com');$('finish').onclick=finish;
if(savedSettings)applySettings({...savedSettings,practiceType:'character'});
lock();reset();
function handleSerialPacket(packet){
  if(packet.type==='diagnostic'){
   $('serialDiagnostic').textContent=`已读取 ${packet.samples} 次 · 最近读取 ${new Date().toLocaleTimeString()} · 最大采样间隔 ${packet.maxInterval.toFixed(1)} ms · RTS ${packet.rts?'高':'低'} · DTR 低；变化次数 CTS ${packet.changes.cts} / DSR ${packet.changes.dsr} / DCD ${packet.changes.cd}`;
  }else if(packet.type==='status'){
   const was=connected;connected=packet.connected;connecting=packet.connecting;armed=packet.armed===true;
   if(!connected){armed=false;rawDown=false;rawDash=false;outputDown=false;for(const id of ['pinCts','pinDsr','pinCd']){$(id).className='';$(id).querySelector('b').textContent='—';}if(was&&running&&source==='com')finish();}
   if(packet.inputSnapshot){rawDown=packet.inputSnapshot.dot;rawDash=packet.inputSnapshot.dash;for(const [id,key] of [['pinCts','cts'],['pinDsr','dsr'],['pinCd','cd']]){const high=!!packet.inputSnapshot.raw[key];$(id).classList.toggle('high',high);$(id).querySelector('b').textContent=high?'高':'低';}}
   if(packet.config){const c=packet.config;if(!$('port').querySelector(`option[value="${c.port}"]`))$('port').add(new Option(c.port,c.port));$('port').value=c.port;$('keyPin').value=c.keyPin;$('keyPolarity').value=c.keyLow?'low':'high';$('rts').value=c.rtsHigh?'high':'low';$('wpm').value=c.wpm;if(!running)reset();lock();}
   if(packet.message)say(packet.message);lock();
  }else if(packet.type==='armed'){armed=true;lock();say(packet.message);}
  else if(packet.type==='inputs'){
   rawDown=packet.dot;rawDash=packet.dash;armed=packet.armed||armed;
   for(const [id,key] of [['pinCts','cts'],['pinDsr','dsr'],['pinCd','cd']]){const high=!!packet.raw[key];$(id).classList.toggle('high',high);$(id).querySelector('b').textContent=high?'高':'低';}
  }else if(packet.type==='edge'){serialEdge(packet.down,packet.t);}
  else if(packet.type==='warning')say(packet.message);
}
await refreshPorts();
window.addEventListener('pagehide',()=>{void serial.disconnect();});
function frame(time){if(time-lastFrame>50&&running){checkAdvance();render();lastFrame=time;}requestAnimationFrame(frame);}requestAnimationFrame(frame);

if(savedSettings){
 $('practiceType').value=savedSettings.practiceType;
 if(savedSettings.practiceType!=='character')await $('practiceType').onchange();
 else changeQuestion();
 practiceModeUI();$('cookieStatus').textContent='已恢复上次保存的设置。';
}
for(const id of Object.keys(settingsDefaults)){
 const event=['wpm','zoom'].includes(id)?'oninput':'onchange';
 const previous=$(id)[event];
 $(id)[event]=async function(e){if(previous)await previous.call(this,e);saveSettings();};
}
$('clearCookies').onclick=()=>{
 if(running||playing||busy||connected||connecting)return;
 document.cookie=`${SETTINGS_COOKIE}=; Max-Age=0; Path=/; SameSite=Strict`;
 applySettings(settingsDefaults);
 $('port').value=$('port').options?.[0]?.value||'';
 selectedMode='character';tone(false);changeQuestion();practiceModeUI();lock();
 $('cookieStatus').textContent='已清除本程序的设置 Cookie，并恢复默认设置。';
};
