// Only controlled Node processes. The private supervisor channel owns cleanup.
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const [role, portText, token, mode] = process.argv.slice(2);
if (!['root','tool','leaf','unrelated'].includes(role) || !token) throw Error('invalid fixture input');
const socket = net.connect({host:'127.0.0.1',port:Number(portText)});
let sequence = 0, buffer = '';
const send = type => socket.write(JSON.stringify({type,token,role,pid:process.pid,ppid:process.ppid,sequence:++sequence})+'\n');
const timer = setInterval(() => { if (!socket.connecting && !socket.destroyed) send('heartbeat'); },50);
// If the controller crashes, a closed private channel/watchdog prevents leaked fixtures.
socket.on('error',()=>process.exit(2));
socket.on('close',()=>process.exit(0));
setTimeout(()=>process.exit(3),40_000).unref();
socket.on('data',chunk=>{
  buffer += chunk;
  let end;
  while ((end=buffer.indexOf('\n'))>=0) {
    const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
    if(message.token===token && message.type==='exit') {clearInterval(timer);process.exit(0);}
  }
});
socket.once('connect',()=>{
  send('hello');
  const next = role==='root' ? 'tool' : role==='tool' ? 'leaf' : undefined;
  if(next) {
    const detached=next==='leaf' && mode==='detached';
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),next,portText,token,mode],{
      stdio:'ignore',shell:false,windowsHide:true,detached,
    });
    child.once('error',()=>process.exit(4));
    if(detached)child.unref();
  }
});
