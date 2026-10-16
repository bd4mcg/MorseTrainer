export const CODES=Object.freeze({A:'.-',B:'-...',C:'-.-.',D:'-..',E:'.',F:'..-.',G:'--.',H:'....',I:'..',J:'.---',K:'-.-',L:'.-..',M:'--',N:'-.',O:'---',P:'.--.',Q:'--.-',R:'.-.',S:'...',T:'-',U:'..-',V:'...-',W:'.--',X:'-..-',Y:'-.--',Z:'--..','0':'-----','1':'.----','2':'..---','3':'...--','4':'....-','5':'.....','6':'-....','7':'--...','8':'---..','9':'----.','?':'..--..','/':'-..-.','=':'-...-','.':'.-.-.-',',':'--..--',"+":".-.-.","&":".-...","(":"-.--.",")":"-.--.-","-":"-....-",":":"---...","'":".----.","\"":".-..-.","@":".--.-."});
export const decode=code=>Object.keys(CODES).find(k=>CODES[k]===code)||'?';
export function makeLesson(text,wpm=15){
 const normalized=text.trim().toUpperCase().replace(/\s+/g,' ');
 if(!normalized||[...normalized].some(c=>c!==' '&&!CODES[c]))throw new Error('请输入字母、数字或支持的摩尔斯符号，空格表示单词间距。');
 if(!Number.isFinite(wpm)||wpm<5||wpm>40)throw new Error('速度范围为 5–40 WPM。');
 const unit=1200/wpm,marks=[],letters=[];let time=0;
 [...normalized].forEach((char,ci)=>{
  if(char===' ')return;
  const letter={char,code:CODES[char],index:letters.length,start:time,first:marks.length};
  [...letter.code].forEach((symbol,si)=>{
   const duration=(symbol==='.'?1:3)*unit;
   const gapUnits=si<letter.code.length-1?1:normalized[ci+1]===' '?7:3;
   marks.push({symbol,char,letter:letter.index,part:si,start:time,duration,gap:gapUnits*unit,gapKind:gapUnits===1?'码内':gapUnits===3?'字母':'单词'});
   time+=duration+gapUnits*unit;
  });
  letter.last=marks.length-1;letter.end=marks.at(-1).start+marks.at(-1).duration;letters.push(letter);
 });
 return {text:normalized,unit,wpm,marks,letters,duration:marks.at(-1).start+marks.at(-1).duration};
}
export function checkTiming(actual,target,tolerance=.2){
 if(target===null||target===undefined)return {actual,target:null,delta:null,error:null,ok:false,label:'无对应标准'};
 const delta=actual-target,error=delta/target,ok=Math.abs(delta)<=target*tolerance+1e-7;
 return {actual,target,delta,error,ok,label:ok?'合格':delta<0?'偏短':'偏长'};
}
export class Practice {
 constructor(lesson,tolerance=.2){this.lesson=lesson;this.tolerance=tolerance;this.marks=[];this.gaps=[];this.origin=null;this.downAt=null;this.lastEnd=null;this.lastTime=-Infinity;this.finished=false;this.discarded=false;}
 edge(down,time){
  if(this.finished||!Number.isFinite(time)||time<this.lastTime)return false;
  this.lastTime=time;
  if(down){
   if(this.downAt!==null)return false;
   this.origin??=time;
   const i=this.marks.length;
   if(this.lastEnd!==null){const e=this.lesson.marks[i-1];this.gaps.push({index:i-1,start:this.lastEnd-this.origin,end:time-this.origin,kind:e?.gapKind??'额外',...checkTiming(time-this.lastEnd,e?.gap,this.tolerance)});}
   this.downAt=time;return true;
  }
  if(this.downAt===null)return false;
  const i=this.marks.length,e=this.lesson.marks[i],duration=time-this.downAt;
  const symbol=duration<2*this.lesson.unit?'.':'-';
  this.marks.push({index:i,start:this.downAt-this.origin,end:time-this.origin,symbol,expected:e,correct:!!e&&symbol===e.symbol,...checkTiming(duration,e?.duration,this.tolerance)});
  this.lastEnd=time;this.downAt=null;return true;
 }
 finish(){this.discarded=this.downAt!==null;this.downAt=null;this.finished=true;}
 received(now=this.lastTime,includeWordSpaces=false){
  const groups=[];let code='';
  this.marks.forEach((m,i)=>{
   const gap=i?m.start-this.marks[i-1].end:0;
   if(i&&gap>=2*this.lesson.unit){
    groups.push(decode(code));code='';
    // Midpoint between a three-unit letter gap and a seven-unit word gap.
    // Use only received timing, never the target sentence's spaces.
    if(includeWordSpaces&&gap>=5*this.lesson.unit)groups.push(' ');
   }
   code+=m.symbol;
  });
  if(code){const settled=this.finished||(this.downAt===null&&now-this.lastEnd>=2*this.lesson.unit);groups.push(settled?decode(code):code.replaceAll('.','·').replaceAll('-','−'));}
  return groups;
 }
 summary(){
  const good=this.marks.filter(m=>m.ok&&m.correct).length;
  const letterGaps=this.gaps.filter(g=>g.kind==='字母'||g.kind==='单词');
  return {good,total:this.marks.length,expected:this.lesson.marks.length,missing:this.finished?Math.max(0,this.lesson.marks.length-this.marks.length):0,extra:Math.max(0,this.marks.length-this.lesson.marks.length),gapGood:letterGaps.filter(g=>g.ok).length,gapTotal:letterGaps.length};
 }
}
