
fetch('/api/state').then(r=>r.json()).then(s=>{
 document.getElementById('status').textContent=s.status;
 document.getElementById('users').innerHTML=s.users.map(x=>`<li>${x}</li>`).join('');
 document.getElementById('admins').innerHTML=s.admins.map(x=>`<li>${x}</li>`).join('');
 document.getElementById('logs').textContent=s.logs.join('\n');
}).catch(()=>{});
