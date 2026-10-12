const {ipcRenderer,webFrame}=require('electron');
ipcRenderer.on('private-paint-read',async(_event,request)=>{
 let descriptor=null;
 try{descriptor=await webFrame.executeJavaScript('window.privatePaintRead('+JSON.stringify(request).replaceAll('<','\\u003c')+')');}catch{}
 ipcRenderer.send('private-paint-reply',{...request,descriptor});
});
