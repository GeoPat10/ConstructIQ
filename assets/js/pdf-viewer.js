/* High-resolution, single-page PDF viewing. All renderer assets are packaged locally. */
(function(root){
 const MAX_PIXELS=16_000_000;
 function renderSize(width,height,fit,zoom,dpr=1){const scale=fit*zoom;const w=Math.max(1,width*scale),h=Math.max(1,height*scale);const output=Math.min(Math.max(1,dpr),Math.sqrt(MAX_PIXELS/(w*h)));return {scale,width:w,height:h,outputScale:output,pixelWidth:Math.max(1,Math.floor(w*output)),pixelHeight:Math.max(1,Math.floor(h*output))};}
 if(typeof module!=='undefined')module.exports={renderSize};root.CIPdfGeometry={renderSize};
 if(typeof document==='undefined')return;
 let doc=null,task=null,loading=null,source=null,pageNo=1,zoom=1,rotation=0,sequence=0,fit=1,oldOverflow='',imageUrl=null,imageSize=null;
 const el=id=>document.getElementById(id);
 const controls=()=>{el('pdfPageNumber').textContent=pageNo+' / '+(doc?.numPages||1);el('pdfZoomLabel').textContent=Math.round(zoom*100)+'%';el('pdfPrevious').disabled=!doc||pageNo===1;el('pdfNext').disabled=!doc||pageNo===doc.numPages;};
 async function renderer(){const pdf=await import(new URL('assets/vendor/pdfjs/pdf.mjs',document.baseURI).href);pdf.GlobalWorkerOptions.workerSrc=new URL('assets/vendor/pdfjs/pdf.worker.mjs',document.baseURI).href;return pdf;}
 async function paint(){
  const current=++sequence;if(task){task.cancel();task=null;}if(!doc&&!imageSize)return;
  el('pdfViewerStatus').hidden=false;el('pdfViewerStatus').textContent='Rendering drawing…';
  try{
   const page=doc?await doc.getPage(pageNo):null;if(current!==sequence)return;
   const base=page?page.getViewport({scale:1,rotation}):imageSize;
   fit=Math.max(.05,(el('pdfViewport').clientWidth-32)/base.width);
   const plan=renderSize(base.width,base.height,fit,zoom,window.devicePixelRatio||1);const surface=document.createElement(page?'canvas':'img');
   surface.style.width=plan.width+'px';surface.style.height=plan.height+'px';surface.style.display='block';surface.style.margin='0 auto';
   if(page){surface.width=plan.pixelWidth;surface.height=plan.pixelHeight;surface.style.background='white';surface.setAttribute('aria-label','Drawing page '+pageNo);}
   else {surface.src=imageUrl;surface.alt=el('pdfViewerTitle').textContent;}
   el('pdfViewerPages').replaceChildren(surface);controls();
   if(page){task=page.render({canvasContext:surface.getContext('2d'),viewport:page.getViewport({scale:plan.scale,rotation}),transform:[plan.outputScale,0,0,plan.outputScale,0,0]});await task.promise;}
   if(current!==sequence)return;el('pdfViewerStatus').hidden=true;task=null;
  }catch(error){if(current!==sequence||error.name==='RenderingCancelledException')return;el('pdfViewerStatus').textContent='Could not render this page. Try a lower zoom level or download the original PDF.';}
 }
 async function close(){sequence++;if(task)task.cancel();task=null;const old=doc;doc=null;if(loading){await loading.destroy().catch(()=>{});loading=null;}else if(old)await old.destroy().catch(()=>{});if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=null;imageSize=null;source=null;el('pdfViewerPages').replaceChildren();el('pdfViewerOverlay').style.display='none';document.body.style.overflow=oldOverflow;}
 async function open(blob,title){
  await close();oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';source={blob,title:title||'Drawing'};pageNo=1;zoom=1;rotation=0;
  el('pdfViewerTitle').textContent=source.title;el('pdfViewerOverlay').style.display='flex';el('pdfViewerStatus').hidden=false;el('pdfViewerStatus').textContent='Opening document…';const current=++sequence;
  try{
   if(blob.type.startsWith('image/')){imageUrl=URL.createObjectURL(blob);const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=imageUrl;});if(current!==sequence)return;imageSize={width:image.naturalWidth,height:image.naturalHeight};}
   else{const pdf=await renderer();if(current!==sequence)return;loading=pdf.getDocument({data:new Uint8Array(await blob.arrayBuffer()),isEvalSupported:false,cMapUrl:new URL('assets/vendor/pdfjs/cmaps/',document.baseURI).href,cMapPacked:true,standardFontDataUrl:new URL('assets/vendor/pdfjs/standard_fonts/',document.baseURI).href,wasmUrl:new URL('assets/vendor/pdfjs/wasm/',document.baseURI).href});loading.onPassword=(update,reason)=>{const password=prompt(reason===2?'That password did not work. Enter the PDF password:':'Enter the PDF password:');if(password===null){close();return;}update(password);};const result=await loading.promise;if(current!==sequence){await result.destroy();return;}doc=result;}
   await paint();
  }catch(error){if(current!==sequence)return;el('pdfViewerStatus').hidden=false;el('pdfViewerStatus').textContent='Could not open this document. Check that the file is a supported PDF or image. You can download the original file.';}
 }
 function setZoom(value){zoom=Math.min(6,Math.max(.25,value));paint();}
 function step(delta){if(!doc)return;pageNo=Math.min(doc.numPages,Math.max(1,pageNo+delta));el('pdfViewport').scrollTo(0,0);paint();}
 root.CIPdfViewer={open,close,setZoom,step,zoomIn:()=>setZoom(zoom*1.25),zoomOut:()=>setZoom(zoom/1.25),fit:()=>setZoom(1),rotate:()=>{rotation=(rotation+90)%360;paint();},download:()=>{if(source)downloadFile(new File([source.blob],source.title,{type:source.blob.type}));}};
 // Pointer panning works with a mouse or one finger; two fingers change the render zoom.
 const pointers=new Map();let drag=null,pinch=null;
 const viewport=el('pdfViewport');
 viewport.addEventListener('pointerdown',event=>{if(!doc&&!imageSize)return;pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});viewport.setPointerCapture(event.pointerId);drag={x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),zoom};}});
 viewport.addEventListener('pointermove',event=>{if(!pointers.has(event.pointerId))return;pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});if(pointers.size===2&&pinch){const [a,b]=[...pointers.values()];const ratio=Math.hypot(a.x-b.x,a.y-b.y)/Math.max(1,pinch.distance);zoom=Math.min(6,Math.max(.25,pinch.zoom*ratio));el('pdfZoomLabel').textContent=Math.round(zoom*100)+'%';}else if(drag){viewport.scrollLeft=drag.left-(event.clientX-drag.x);viewport.scrollTop=drag.top-(event.clientY-drag.y);}});
 const release=event=>{pointers.delete(event.pointerId);if(pinch){pinch=null;paint();}drag=null;};viewport.addEventListener('pointerup',release);viewport.addEventListener('pointercancel',release);
 viewport.addEventListener('wheel',event=>{if(event.ctrlKey){event.preventDefault();setZoom(zoom*(event.deltaY<0?1.1:1/1.1));}},{passive:false});
 window.addEventListener('resize',()=>{if(doc||imageSize)paint();});
})(typeof globalThis!=='undefined'?globalThis:this);
