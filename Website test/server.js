
const express=require('express');
const http=require('http');
const {Server}=require('socket.io');

const app=express();
const server=http.createServer(app);
const io=new Server(server);

app.use(express.json());
app.use(express.static('public'));

let state={
 status:'Offline',
 users:['xXdariavXx','FacelessUum'],
 admins:['xXdariavXx'],
 logs:['Dashboard started'],
 settings:{theme:'dark'}
};

app.get('/api/state',(req,res)=>res.json(state));

io.on('connection',socket=>{
 socket.emit('state',state);
});

server.listen(3000,()=>console.log('Dashboard on :3000'));
