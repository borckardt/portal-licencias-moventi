(function(){
  "use strict";

  /* ================= state & capabilities ================= */
  // Token compartido opcional para el endpoint /api/send-email (ver SETUP_GMAIL.md).
  // No es un secreto fuerte: vive en el HTML de esta página. Déjalo vacío si no usas ese backend.
  var PORTAL_API_TOKEN = 'FEn_CYyxfOZn8Q1BTXsDMxxJI-1fi9B5';
  // Este mismo app.js lo cargan dos páginas separadas (index.html para
  // clientes, admin.html para el administrador — ver ambos archivos). Cada
  // una define window.PORTAL_ENTRY_MODE antes de este script para fijar qué
  // perfil de login se muestra; ya no hay un selector de "Cliente/Admin" en
  // pantalla, así que un cliente jamás ve ni puede intentar la puerta de
  // administrador, y viceversa.
  var ENTRY_MODE = (typeof window !== 'undefined' && window.PORTAL_ENTRY_MODE === 'admin') ? 'admin' : 'client';
  // A dónde llega el aviso automático de "nueva solicitud creada por un
  // cliente", por defecto (se usa solo si no hay destinatarios configurados
  // en STATE.settings.notifyEmails desde el panel de administrador —
  // pestaña "Notificaciones").
  var NEW_REQUEST_NOTIFY_EMAILS = ['sborckardt@moventiglobal.com', 'administracion@moventiglobal.com'];
  var DEFAULT_EMAIL_SUBJECT = 'Solicitud de habilitación de licencias — Moventi ({{cantidad}} {{unidad}})';
  var DEFAULT_EMAIL_BODY = 'Hola,\n\nSe solicita generar/habilitar las siguientes licencias aprobadas:\n\n{{detalle}}\n\nSaludos,\n{{admin}}';
  // Proyectos/servicios del cliente a los que puede vincularse la cuenta que
  // se está solicitando. Por ahora es una lista fija compartida por todos los
  // clientes del portal; si más adelante cada cliente necesita su propia
  // lista, esto puede moverse a STATE (como los tipos de licencia) y
  // administrarse desde el panel.
  // Proyectos/servicios a los que se vincula la cuenta. Son administrables
  // desde el panel (pestaña Proyectos) y viven en STATE.projects; esta lista
  // solo es la semilla inicial para portales que aún no tienen ninguno.
  var PROJECT_DEFAULTS = ['Ligo-Prod', 'LigoCloudPlatform', 'Ligo-Dev'];

  var STATE = JSON.parse(document.getElementById('app-state').textContent);
  if(!STATE.settings) STATE.settings = { ingramEmail: '' };
  if(STATE.settings.ingramCc===undefined) STATE.settings.ingramCc = '';
  // Destinatarios configurables del aviso de "nueva solicitud creada por un
  // cliente" (pestaña Notificaciones del panel admin). Se siembra una vez
  // con los correos que antes estaban fijos en el código, para no perder
  // destinatarios existentes al desplegar este cambio.
  if(!STATE.settings.notifyEmails){
    STATE.settings.notifyEmails = NEW_REQUEST_NOTIFY_EMAILS.map(function(e){
      return { id: uid('ne'), name: '', email: e };
    });
  }
  // Cuando corremos como sitio Vercel (fuera del runtime de artifacts de
  // Claude), los datos compartidos (clientes, solicitudes, tipos de
  // licencia) viven en Vercel Blob vía /api/get-state y /api/save-state, así
  // que cualquier navegador/dispositivo ve el mismo dato. baseRemoteState
  // guarda el último snapshot conocido del backend, usado para fusionar
  // cambios concurrentes en vez de pisarlos (ver mergeCollection).
  var stateBackendAvailable = false;
  var baseRemoteState = null;
  if(!STATE.settings.emailSubjectTemplate) STATE.settings.emailSubjectTemplate = DEFAULT_EMAIL_SUBJECT;
  if(!STATE.settings.emailBodyTemplate) STATE.settings.emailBodyTemplate = DEFAULT_EMAIL_BODY;
  var emailTplOpen = false;
  var artifactCap = null, downloadsCap = null, mcpCap = null, capReady = false;
  var loginRole = ENTRY_MODE;
  var loginError = '';
  var adminTab = 'solicitudes';
  var adminAccountState = { busy:false, done:false, error:'' };
  var reportFilter = { cliente: 'todos', estado: 'todos', tipo: 'todos', proyecto: 'todos' };
  // Mes de cierre del Reporte (AAAA-MM): el prorrateo se calcula contra este
  // mes y no contra la fecha de hoy. Por defecto es el mes anterior, porque el
  // cierre se hace los primeros días del mes siguiente (Ingram factura con un
  // mes de desfase). No se guarda entre sesiones: siempre arranca en el mes
  // anterior, así nadie cierra por error contra un mes viejo.
  function ymDe(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }
  function mesAnteriorYm(){ var d = new Date(); return ymDe(new Date(d.getFullYear(), d.getMonth()-1, 1)); }
  var reportMonth = mesAnteriorYm();
  var solFilter = { cliente: 'todos', estado: 'todos', proyecto: 'todos' };
  var selectedForIngram = new Set();
  var editingRequestId = null;
  var editingClientId = null;
  var notifyTestBusy = false;
  var clientFilterProject = 'todos';
  var confirmDialog = null; // {titulo, mensaje, detalle, etiquetaOk, onOk}
  var openRowMenu = null;
  // Carga de solicitudes históricas (meses pasados) para poner al día la BD.
  var importHistOpen = false;
  var importHistRows = null; // filas ya validadas, listas para confirmar
  var importHistErrors = [];
  var importHistFileName = '';
  var importHistBusy = false;
  var manualHistOpen = false;
  var rowMenuPos = null;
  var currentTheme = 'light';
  var forgotPasswordOpen = false;
  var forgotPasswordSent = false;
  var forgotPasswordBusy = false;
  // Si la URL trae ?resetToken=..., mostramos la pantalla de "nueva contraseña"
  // en vez del login normal, sin importar si hay sesión activa.
  var resetTokenFromUrl = null;
  try{
    var __params = new URLSearchParams(window.location.search);
    resetTokenFromUrl = __params.get('resetToken');
  }catch(e){}
  var resetPasswordState = { busy: false, done: false, error: '' };
  // Si el botón "Revisar y aprobar" del correo de aviso trae
  // ?verSolicitud=<id>, al iniciar sesión como admin saltamos directo a la
  // pestaña Solicitudes con esa fila resaltada, para reducir pasos.
  var highlightRequestId = null;
  var highlightJumpDone = false;
  try{ highlightRequestId = __params.get('verSolicitud'); }catch(e){}

  function initTheme(){
    var saved = null;
    try{ saved = localStorage.getItem('moventi_theme'); }catch(e){}
    currentTheme = (saved==='dark' || saved==='light') ? saved : 'light';
    applyTheme();
  }
  function applyTheme(){
    document.body.classList.toggle('theme-dark', currentTheme==='dark');
    try{ localStorage.setItem('moventi_theme', currentTheme); }catch(e){}
  }
  function themeIcon(){
    if(currentTheme==='dark'){
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><line x1="12" y1="2" x2="12" y2="5"></line><line x1="12" y1="19" x2="12" y2="22"></line><line x1="4.2" y1="4.2" x2="6.3" y2="6.3"></line><line x1="17.7" y1="17.7" x2="19.8" y2="19.8"></line><line x1="2" y1="12" x2="5" y2="12"></line><line x1="19" y1="12" x2="22" y2="12"></line><line x1="4.2" y1="19.8" x2="6.3" y2="17.7"></line><line x1="17.7" y1="6.3" x2="19.8" y2="4.2"></line></svg>';
    }
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"></path></svg>';
  }

  // Iconos minimalistas del nav admin (estilo feather, mismo patrón que themeIcon).
  function navIcon(key){
    var paths = {
      solicitudes: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line>',
      tipos: '<path d="M20.59 13.41 13.42 20.59a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line>',
      clientes: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>',
      proyectos: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>',
      notificaciones: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path>',
      reporte: '<line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line>',
      cuenta: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>'
    };
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+(paths[key]||'')+'</svg>';
  }

  // Iconos para los campos del login (usuario/contraseña).
  function fieldIcon(key){
    var paths = {
      user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>',
      lock: '<rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>'
    };
    return '<span class="login-field-ic" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+(paths[key]||'')+'</svg></span>';
  }

  // Icono del botón mostrar/ocultar contraseña.
  function eyeIcon(visible){
    var d = visible
      ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path><line x1="1" y1="1" x2="23" y2="23"></line>'
      : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+d+'</svg>';
  }

  function uid(prefix){ return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

  // ---------- Carga de histórico (solicitudes de meses pasados) ----------
  // Busca un cliente por username o nombre; si no existe, lo crea (sin
  // contraseña: solo sirve para que el histórico quede vinculado a alguien,
  // si va a usar el portal se le agrega usuario/clave desde la pestaña Clientes).
  function ensureHistClient(s, name){
    var n = String(name||'').trim();
    if(!n) return null;
    var found = s.users.find(function(u){ return u.role==='client' && (u.username.toLowerCase()===n.toLowerCase() || u.name.toLowerCase()===n.toLowerCase()); });
    if(found) return found;
    var base = n.toUpperCase().replace(/[^A-Z0-9]+/g,'').slice(0,24) || 'CLIENTE';
    var username = base, i = 1;
    while(s.users.some(function(u){ return u.username===username; })){ username = base+i; i++; }
    var nuevo = { id: uid('u'), username: username, name: n, role:'client', active:true, email:'' };
    s.users.push(nuevo);
    return nuevo;
  }
  // Normaliza el nombre de un tipo de licencia para comparar "el mismo
  // concepto escrito distinto" (ej. Ingram nombra el SKU "... Annual
  // Monthly" mientras que el tipo ya creado a mano se llama solo "...").
  function normalizeLicenseTypeName(name){
    return String(name||'').trim().toLowerCase().replace(/\s+annual\s+monthly\s*$/,'').replace(/\s+/g,' ').trim();
  }
  function ensureHistLicenseType(s, name, price){
    var n = String(name||'').trim();
    if(!n) return null;
    var norm = normalizeLicenseTypeName(n);
    var t = s.licenseTypes.find(function(x){ return normalizeLicenseTypeName(x.name)===norm; });
    if(t) return t;
    var nuevo = { id: uid('lt'), name: n, price: Number(price)||0, active:true };
    s.licenseTypes.push(nuevo);
    return nuevo;
  }
  // Fusiona tipos de licencia que ya hayan quedado duplicados (mismo
  // concepto, nombre distinto): reasigna las solicitudes del duplicado al
  // tipo que se conserva y elimina el duplicado. Se ejecuta una vez al
  // cargar el estado remoto, por si quedaron duplicados de antes de que
  // ensureHistLicenseType empezara a normalizar el nombre.
  function mergeDuplicateLicenseTypes(s){
    if(!s || !Array.isArray(s.licenseTypes) || s.licenseTypes.length<2) return false;
    var groups = {};
    s.licenseTypes.forEach(function(t){
      var key = normalizeLicenseTypeName(t.name);
      (groups[key] = groups[key]||[]).push(t);
    });
    var changed = false, toRemove = [];
    Object.keys(groups).forEach(function(key){
      var group = groups[key];
      if(group.length<2) return;
      // Se conserva el nombre "corto" (sin "Annual Monthly"); si ninguno o
      // todos lo tienen, se conserva el primero.
      var keep = group.find(function(t){ return !/annual\s+monthly/i.test(t.name); }) || group[0];
      group.forEach(function(t){
        if(t.id===keep.id) return;
        (s.requests||[]).forEach(function(r){
          if(r.licenseTypeId===t.id){ r.licenseTypeId = keep.id; r.licenseTypeName = keep.name; }
        });
        toRemove.push(t.id);
        changed = true;
      });
    });
    if(toRemove.length) s.licenseTypes = s.licenseTypes.filter(function(t){ return toRemove.indexOf(t.id)===-1; });
    return changed;
  }
  function ensureHistProject(s, name){
    var n = String(name||'').trim();
    if(!n) return '';
    if(!Array.isArray(s.projects) || !s.projects.length) s.projects = projectList().slice();
    var p = s.projects.find(function(x){ return x.name.toLowerCase()===n.toLowerCase(); });
    if(!p){ p = { id: uid('pj'), name:n, active:true }; s.projects.push(p); }
    return p.name;
  }
  // Parsea una línea CSV respetando comillas ("valor con ; adentro").
  function parseHistCsvLine(line, delim){
    var out = [], cur = '', inQ = false;
    for(var i=0;i<line.length;i++){
      var c = line[i];
      if(inQ){
        if(c==='"'){ if(line[i+1]==='"'){ cur+='"'; i++; } else inQ=false; }
        else cur+=c;
      }else{
        if(c==='"') inQ=true;
        else if(c===delim){ out.push(cur); cur=''; }
        else cur+=c;
      }
    }
    out.push(cur);
    return out.map(function(x){ return x.trim(); });
  }
  var HIST_CSV_HEADER = ['Cliente','Tipo de licencia','Proyecto','Cantidad','Precio unitario (US$)','Fecha de solicitud (DD/MM/AAAA)','Fecha requerida (DD/MM/AAAA)','Fecha de activación (DD/MM/AAAA)','Estado (opcional, default activado)','Gestionado por (opcional)'];
  // Acepta DD/MM/AAAA, DD-MM-AAAA y también AAAA-MM-DD (por si se pega desde
  // un export previo). Cuando el día y el mes son ambiguos (ambos <=12) se
  // asume DD/MM/AAAA (convención local); si uno de los dos es >12, ese es el
  // día sin importar en qué posición vino (para tolerar planillas mezcladas
  // como "8-19-2026" = 19 de agosto). Devuelve 'AAAA-MM-DD' o null si no se
  // pudo interpretar.
  function parseFlexibleDate(str){
    var s = String(str||'').trim();
    if(!s) return null;
    var m = s.match(/^(\d{1,4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,4})$/);
    if(!m) return null;
    var a = m[1], b = +m[2], c = m[3];
    var anio, dia, mes;
    if(a.length===4){ anio = +a; dia = +c; mes = b; } // AAAA-MM-DD
    else {
      anio = +c; if(String(c).length===2) anio = 2000+(+c);
      var x = +a, y = b;
      if(x>12 && y<=12){ dia = x; mes = y; }
      else if(y>12 && x<=12){ dia = y; mes = x; }
      else { dia = x; mes = y; } // ambos <=12: asumimos DD/MM/AAAA
    }
    if(mes<1 || mes>12 || dia<1 || dia>31 || anio<1970 || anio>2100) return null;
    return anio+'-'+String(mes).padStart(2,'0')+'-'+String(dia).padStart(2,'0');
  }
  function parseHistCsv(text){
    var raw = String(text||'').replace(/^﻿/, '').split(/\r\n|\n|\r/).filter(function(l){ return l.length; });
    if(!raw.length) return { rows:[], errors:['El archivo está vacío.'] };
    var delim = raw[0].indexOf(';')>-1 ? ';' : ',';
    var rows = [], errors = [];
    for(var i=1;i<raw.length;i++){
      var cols = parseHistCsvLine(raw[i], delim);
      var rowNum = i+1;
      var cliente = cols[0]||'', tipo = cols[1]||'', proyecto = cols[2]||'', cantidad = cols[3]||'', precio = cols[4]||'',
        fSolRaw = cols[5]||'', fReqRaw = cols[6]||'', fActRaw = cols[7]||'',
        estado = (cols[8]||'activado').toLowerCase().trim() || 'activado', gestor = cols[9]||'';
      if(!cliente || !tipo || !cantidad || !precio || !fSolRaw || !fReqRaw){
        errors.push('Fila '+rowNum+': faltan datos obligatorios (cliente, tipo, cantidad, precio, fecha de solicitud o fecha requerida).');
        continue;
      }
      if(ESTADOS.indexOf(estado)===-1){
        errors.push('Fila '+rowNum+': estado "'+estado+'" no reconocido (usar: '+ESTADOS.join(', ')+').');
        continue;
      }
      if(estado==='activado' && !fActRaw){
        errors.push('Fila '+rowNum+': estado "activado" requiere fecha de activación.');
        continue;
      }
      var fSol = parseFlexibleDate(fSolRaw), fReq = parseFlexibleDate(fReqRaw), fAct = fActRaw ? parseFlexibleDate(fActRaw) : '';
      if(!fSol || !fReq || (fActRaw && !fAct)){
        errors.push('Fila '+rowNum+': no se pudo interpretar alguna fecha (usar DD/MM/AAAA).');
        continue;
      }
      var qty = parseInt(cantidad,10);
      var price = Number(precio);
      if(!qty || qty<1){ errors.push('Fila '+rowNum+': cantidad inválida.'); continue; }
      if(isNaN(price) || price<0){ errors.push('Fila '+rowNum+': precio unitario inválido.'); continue; }
      rows.push({ cliente:cliente, tipo:tipo, proyecto:proyecto, cantidad:qty, precio:price, fSol:fSol, fReq:fReq, fAct:fAct, estado:estado, gestor:gestor });
    }
    return { rows: rows, errors: errors };
  }
  // Arma el objeto de solicitud a partir de una fila ya validada (CSV o
  // formulario manual) y crea cliente/tipo/proyecto si hiciera falta.
  function buildHistRequest(s, row){
    var cli = ensureHistClient(s, row.cliente);
    var tipo = ensureHistLicenseType(s, row.tipo, row.precio);
    var proyecto = ensureHistProject(s, row.proyecto);
    var estado = row.estado || 'activado';
    var enviado = estado!=='pendiente';
    var req = {
      id: uid('r'),
      clientUsername: cli ? cli.username : '',
      clientName: cli ? cli.name : row.cliente,
      licenseTypeId: tipo ? tipo.id : '',
      licenseTypeName: tipo ? tipo.name : row.tipo,
      project: proyecto,
      price: row.precio,
      quantity: row.cantidad,
      neededFrom: row.fReq,
      note: 'Cargado como histórico (dato de meses pasados).',
      requestedAt: row.fSol+'T00:00:00.000Z',
      status: estado,
      reviewedBy: null, reviewedAt: null,
      notifiedToIngram: enviado, notifiedAt: enviado ? row.fSol+'T00:00:00.000Z' : null, notifiedBy: enviado ? 'Carga histórica' : null,
      activatedAt: estado==='activado' ? row.fAct : null,
      activatedBy: estado==='activado' ? (row.gestor || 'Carga histórica') : null,
      historico: true
    };
    return req;
  }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  // Convierte "a@x.com, b@y.com ,, c@z.com" en ['a@x.com','b@y.com','c@z.com'],
  // descartando entradas vacías/inválidas (sin '@').
  function parseEmailList(str){
    return (str||'').split(',').map(function(s){ return s.trim(); }).filter(function(s){ return s && s.indexOf('@')>-1; });
  }
  function money(n){ return 'US$ ' + Number(n||0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); }
  function renderTemplate(tpl, vars){
    return String(tpl||'').replace(/\{\{(\w+)\}\}/g, function(_, key){ return (key in vars) ? String(vars[key]) : ''; });
  }
  // Renders a template to HTML: plain text segments are escaped and newlines
  // become <br>, but any placeholder listed in htmlOverrides is inserted as
  // raw HTML (e.g. so {{detalle}} can become a real <table>).
  function renderTemplateHtml(tpl, vars, htmlOverrides){
    var re = /\{\{(\w+)\}\}/g;
    var out = '', lastIndex = 0, m;
    var src = String(tpl||'');
    while((m = re.exec(src))){
      if(m.index > lastIndex) out += esc(src.slice(lastIndex, m.index)).replace(/\n/g, '<br>');
      var key = m[1];
      if(htmlOverrides && Object.prototype.hasOwnProperty.call(htmlOverrides, key)) out += htmlOverrides[key];
      else out += esc((vars && key in vars) ? String(vars[key]) : '');
      lastIndex = re.lastIndex;
    }
    if(lastIndex < src.length) out += esc(src.slice(lastIndex)).replace(/\n/g, '<br>');
    return out;
  }
  // Envío de correo "mejor esfuerzo": intenta el backend /api/send-email
  // (Vercel), luego el conector de Gmail de Claude si está disponible, y si
  // ninguno existe simplemente no hace nada — nunca interrumpe al usuario ni
  // abre un cliente de correo por su cuenta, porque esto corre automático
  // (no a partir de un clic explícito de "enviar").
  var lastEmailError = null; // motivo del último envío fallido (se muestra en Notificaciones)
  async function sendEmailBestEffort(toList, subject, text, html){
    var to = toList.join(', ');
    lastEmailError = null;
    try{
      var apiResp = await fetch('/api/send-email', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, PORTAL_API_TOKEN ? { 'x-portal-token': PORTAL_API_TOKEN } : {}),
        body: JSON.stringify({ to: to, subject: subject, text: text, html: html })
      });
      if(apiResp.ok) return true;
      // Un fallo acá antes se perdía sin rastro (p.ej. 403 recipient_not_allowed
      // cuando el destinatario no estaba en la lista blanca del endpoint).
      lastEmailError = 'HTTP ' + apiResp.status;
      try{
        var errData = await apiResp.json();
        if(errData && errData.error) lastEmailError = errData.error + (errData.blocked ? ' ('+errData.blocked.join(', ')+')' : '');
      }catch(e2){}
      console.error('send-email fallo:', lastEmailError);
    }catch(e){ /* backend no disponible en este hosting, seguimos abajo */ }
    if(mcpCap){
      try{
        await mcpCap.callTool('Gmail', 'send_message', { to: toList, subject: subject, body: text, htmlBody: html });
        return true;
      }catch(e){ /* sin Gmail conectado en este contexto; fallamos en silencio */ }
    }
    return false;
  }

  async function notifyNewRequest(r){
    // La pestaña del cliente pudo cargar antes de que el admin agregara o
    // cambiara destinatarios: sin releer, el aviso sale a la lista vieja.
    await syncStateFromBackend();
    var recipients = (STATE.settings.notifyEmails||[])
      .map(function(n){ return (n.email||'').trim(); })
      .filter(function(e){ return e && e.indexOf('@')>-1; });
    if(!recipients.length) recipients = NEW_REQUEST_NOTIFY_EMAILS;

    // Enlace de un clic para que quien recibe el aviso (p.ej. un
    // colaborador sin más tarea que aprobar) caiga directo en el panel de
    // administrador con esta solicitud ya localizada y resaltada, en vez de
    // tener que entrar y buscarla manualmente entre todas las demás. Los
    // navegadores/clientes de correo abren los enlaces normales en una
    // pestaña nueva por defecto; target="_blank" además lo refuerza cuando
    // el cliente de correo respeta ese atributo.
    // El portal sirve /admin como ruta propia (ver vercel.json / admin.html),
    // así que construimos la URL contra el origen, no contra la ruta actual
    // (esta función corre en la página de cliente, no en la de admin).
    var approveUrl = window.location.origin + '/admin?verSolicitud=' + encodeURIComponent(r.id);

    var subject = 'Nueva solicitud de licencia — ' + r.clientName + ' (' + (r.quantity||1) + ' ' + ((r.quantity||1)===1?'licencia':'licencias') + ')';
    var text = 'Se registró una nueva solicitud de licencia:\n\n' +
      '- Cliente: ' + r.clientName + '\n' +
      '- Tipo: ' + r.licenseTypeName + '\n' +
      '- Proyecto: ' + (r.project||'—') + '\n' +
      '- Cantidad: ' + (r.quantity||1) + '\n' +
      '- Fecha requerida: ' + fmtDateShort(r.neededFrom) + '\n' +
      (r.note ? ('- Nota del cliente: ' + r.note + '\n') : '') +
      '\nRevisar y aprobar directamente: ' + approveUrl + '\n' +
      '\n(Si no tienes sesión iniciada, primero te pedirá el login del panel y luego te lleva igual a esta solicitud.)';
    var html = '<div style="font-family:Arial,sans-serif;font-size:14px">' +
      '<p>Se registró una nueva solicitud de licencia:</p>' +
      '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;margin:.4em 0">' +
      '<tr style="background:#f3f4f6"><th style="padding:6px 10px;text-align:left">Cliente</th><th style="padding:6px 10px;text-align:left">Tipo</th><th style="padding:6px 10px;text-align:left">Proyecto</th><th style="padding:6px 10px;text-align:center">Cantidad</th><th style="padding:6px 10px;text-align:left">Fecha requerida</th></tr>' +
      '<tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">'+esc(r.clientName)+'</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">'+esc(r.licenseTypeName)+'</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">'+esc(r.project||'—')+'</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center">'+(r.quantity||1)+'</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">'+fmtDateShort(r.neededFrom)+'</td></tr>' +
      '</table>' +
      (r.note ? ('<p><strong>Nota del cliente:</strong> '+esc(r.note)+'</p>') : '') +
      '<p style="margin-top:18px">' +
        '<a href="'+esc(approveUrl)+'" target="_blank" rel="noopener" ' +
        'style="display:inline-block;background:#4f46e5;color:#ffffff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-family:Arial,sans-serif;font-size:14px">Revisar y aprobar solicitud</a>' +
      '</p>' +
      '<p style="color:#888;font-size:12px">Si no tienes sesión iniciada en el portal, primero te pedirá el usuario y contraseña del panel y luego te lleva igual a esta solicitud.</p>' +
      '</div>';
    // Guardamos el resultado en la propia solicitud para que el admin pueda
    // ver si el aviso salió o no (pestaña Notificaciones), en vez de que un
    // rechazo del endpoint desaparezca sin que nadie se entere.
    var ok = await sendEmailBestEffort(recipients, subject, text, html);
    commit(function(s){
      var target = s.requests.find(function(x){ return x.id===r.id; });
      if(!target) return;
      target.notifyEmailSent = ok;
      target.notifyEmailTo = recipients.join(', ');
      target.notifyEmailError = ok ? null : (lastEmailError || 'sin_backend');
    });
    return ok;
  }

  // Texto largo (nombre de cliente, licencia, dominio de proyecto) en una sola
  // línea con "..." y tooltip, en vez de partirse en varias líneas feas.
  function clipCell(text){
    var t = String(text==null?'':text);
    return '<span class="cell-clip" title="'+esc(t)+'">'+esc(t)+'</span>';
  }
  // Fecha de activación + quién la gestionó, en una sola celda (ahorra una columna).
  function activadaCell(r){
    if(!r.activatedAt) return '<span style="color:var(--ink-subtle)">—</span>';
    var quien = r.activatedBy||r.notifiedBy||'';
    return fmtDateShort(r.activatedAt) + (quien ? '<br><span style="color:var(--ink-subtle);font-size:.7rem">'+esc(quien)+'</span>' : '');
  }
  // Aviso de "licencia activada": va al correo del cliente (pestaña Clientes)
  // con copia a los buzones internos de Notificaciones.
  async function notifyActivation(r){
    if(!r) return false;
    await syncStateFromBackend();
    var cli = STATE.users.find(function(u){ return u.username===r.clientUsername; });
    var destinos = [];
    if(cli && cli.email) destinos.push(String(cli.email).trim());
    (STATE.settings.notifyEmails||[]).forEach(function(n){ if(n && n.email) destinos.push(String(n.email).trim()); });
    destinos = destinos.filter(function(e,i,a){ return e && e.indexOf('@')>-1 && a.indexOf(e)===i; });
    if(!destinos.length) return false;

    var subject = 'Licencia activada — ' + r.licenseTypeName + ' (' + (r.quantity||1) + ')';
    var text = 'Estimado Cliente,\n\nSe le informa que el siguiente pedido de licencias ha sido generado y activado:\n\n' +
      '- Cliente: ' + r.clientName + '\n' +
      '- Tipo: ' + r.licenseTypeName + '\n' +
      '- Proyecto: ' + (r.project||'—') + '\n' +
      '- Cantidad: ' + (r.quantity||1) + '\n' +
      '- Fecha requerida: ' + fmtDateShort(r.neededFrom) + '\n' +
      '- Fecha de activación: ' + fmtDateShort(r.activatedAt||r.neededFrom) + '\n' +
      '\nSaludos,\nMoventi';
    var html = '<div style="font-family:Arial,sans-serif;font-size:14px">' +
      '<p>Estimado Cliente,</p>' +
      '<p>Se le informa que el siguiente pedido de licencias ha sido generado y activado:</p>' +
      '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;margin:.4em 0">' +
      '<tr style="background:#f3f4f6"><th style="padding:6px 10px;text-align:left">Cliente</th><th style="padding:6px 10px;text-align:left">Tipo</th><th style="padding:6px 10px;text-align:left">Proyecto</th><th style="padding:6px 10px;text-align:center">Cantidad</th><th style="padding:6px 10px;text-align:left">Fecha requerida</th><th style="padding:6px 10px;text-align:left">Fecha de activación</th></tr>' +
      '<tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">'+esc(r.clientName)+'</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">'+esc(r.licenseTypeName)+'</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">'+esc(r.project||'—')+'</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center">'+(r.quantity||1)+'</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">'+fmtDateShort(r.neededFrom)+'</td>' +
      '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb"><strong>'+fmtDateShort(r.activatedAt||r.neededFrom)+'</strong></td></tr>' +
      '</table>' +
      '</div>';
    var ok = await sendEmailBestEffort(destinos, subject, text, html);
    commit(function(st){
      var t = st.requests.find(function(x){ return x.id===r.id; });
      if(!t) return;
      t.activationEmailSent = ok;
      t.activationEmailTo = destinos.join(', ');
    });
    return ok;
  }

  function reqTotal(r){ return Number(r.price||0) * Number(r.quantity||1); }
  // Estados: pendiente > aprobado > en proceso (pedida al distribuidor) > activado.
  var ESTADOS = ['pendiente','aprobado','en proceso','activado','rechazado'];
  function statusCls(st){ return 'status-' + String(st||'').replace(/\s+/g,''); }
  // Precio unitario prorrateado: precio unitario / 30 x días restantes del mes
  // desde la fecha de activación (o la requerida, si aún no se activa) hasta
  // el cierre de ese mes. No se cobra el mes completo si la licencia se pide
  // a mitad de mes.
  // Solo aplica en el cierre del mes de activación (el "Mes de cierre" del
  // Reporte); en los cierres siguientes se cobra el mes completo.
  function prorrateo(r){
    if(!esAprobada(r)) return null;
    var ymd = String(r.activatedAt || r.neededFrom || '').slice(0,10);
    var p = ymd.split('-'); if(p.length!==3) return null;
    var anio = +p[0], mes = +p[1], dia = +p[2];
    // Solo se prorratea en el cierre del mes en que se activó la licencia;
    // en los cierres siguientes ya es un mes completo.
    var ref = String(reportMonth||'').split('-');
    if(anio!==+ref[0] || mes!==+ref[1]) return null;
    var diasMes = new Date(anio, mes, 0).getDate();
    var restantes = diasMes - dia + 1;
    var unitario = Number(r.price||0) / 30 * restantes;
    var monto = unitario * Number(r.quantity||1);
    return { monto: monto, unitario: unitario, dias: restantes };
  }
  // Precio unitario final: ya prorrateado cuando aplica (aprobada en
  // adelante), si no, el precio de lista completo.
  function precioUnitFinal(r){
    var pr = prorrateo(r);
    return pr ? pr.unitario : Number(r.price||0);
  }
  function precioUnitCell(r){
    var pr = prorrateo(r);
    if(!pr) return money(r.price||0);
    var base = r.activatedAt ? '' : ' · estimado sobre fecha requerida (se recalcula al activar)';
    return '<span title="'+pr.dias+' días restantes de prorrateo'+base+'">'+money(pr.unitario)+'</span>' +
      '<div class="prorr-tag">Prorrateado · '+pr.dias+' días</div>';
  }
  // Monto total final: precio unitario final (prorrateado o completo) x cantidad.
  function montoTotal(r){ return precioUnitFinal(r) * Number(r.quantity||1); }
  // Fecha de vencimiento: las licencias son anuales, vencen 1 año después de
  // la fecha de activación (o la requerida, si aún no se ha activado).
  function fechaVencimiento(r){
    var ymd = String(r.activatedAt || r.neededFrom || '').slice(0,10);
    var p = ymd.split('-'); if(p.length!==3) return null;
    var anio = +p[0], mes = +p[1], dia = +p[2];
    var d = new Date(anio, mes-1, dia);
    d.setFullYear(d.getFullYear()+1);
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  }
  function vencimientoCell(r){
    var v = fechaVencimiento(r);
    if(!v) return '<span style="color:var(--ink-subtle)">—</span>';
    var base = r.activatedAt ? '' : ' · estimado sobre fecha requerida (se recalcula al activar)';
    return '<span title="Vence 1 año después de la activación'+base+'">'+fmtDateShort(v)+'</span>';
  }
  function puedeEnviarse(r){ return (r.status==='pendiente' || r.status==='aprobado') && !r.notifiedToIngram; }
  function esAprobada(r){ return r.status==='aprobado' || r.status==='en proceso' || r.status==='activado'; }
  function fmtDate(iso){ if(!iso) return '—'; var d = new Date(iso); return d.toLocaleDateString('es-PE', {day:'2-digit', month:'short', year:'numeric'}); }
  // Acepta 'YYYY-MM-DD' y también un ISO con hora ('...T10:00:00.000Z').
  function fmtDateShort(ymd){ if(!ymd) return '—'; var p = String(ymd).slice(0,10).split('-'); return p[2]+'/'+p[1]+'/'+p[0]; }
  function todayYmd(){ var d = new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  function dateOnly(iso){ if(!iso) return null; return iso.slice(0,10); }

  function currentUser(){
    var id = sessionStorage.getItem('moventi_uid');
    if(!id) return null;
    var u = STATE.users.find(function(x){ return x.id===id; });
    // La sesión guardada solo cuenta en la página a la que pertenece: si por
    // cualquier motivo quedó un id de admin en sessionStorage y esta pestaña
    // navega a la página de cliente (o viceversa), no debe auto-loguear al
    // usuario equivocado en la interfaz equivocada.
    if(!u || !u.active || u.role !== ENTRY_MODE) return null;
    return u;
  }
  function setCurrentUser(u){ sessionStorage.setItem('moventi_uid', u ? u.id : ''); }
  function logout(){ sessionStorage.removeItem('moventi_uid'); adminAccountState = { busy:false, done:false, error:'' }; render(); }

  /* ================= persistence ================= */
  function showToast(msg, kind){
    var stack = document.getElementById('toast-stack');
    var el = document.createElement('div');
    el.className = 'toast toast-' + (kind||'info');
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(function(){ el.remove(); }, 3600);
  }

  function saveUiState(){
    try{
      sessionStorage.setItem('moventi_ui', JSON.stringify({ adminTab: adminTab, solFilter: solFilter, reportFilter: reportFilter }));
    }catch(e){}
  }
  function restoreUiState(){
    try{
      var raw = sessionStorage.getItem('moventi_ui');
      if(!raw) return;
      var saved = JSON.parse(raw);
      if(saved.adminTab) adminTab = saved.adminTab;
      if(saved.solFilter) solFilter = saved.solFilter;
      if(saved.reportFilter) reportFilter = saved.reportFilter;
    }catch(e){}
  }

  function loadLocalFallbackState(){
    try{
      var raw = localStorage.getItem('moventi_portal_state_v1');
      if(raw) return JSON.parse(raw);
    }catch(e){}
    return null;
  }
  function saveLocalFallbackState(){
    try{ localStorage.setItem('moventi_portal_state_v1', JSON.stringify(STATE)); }catch(e){}
  }

  function portalApiHeaders(extra){
    return Object.assign({}, extra||{}, PORTAL_API_TOKEN ? { 'x-portal-token': PORTAL_API_TOKEN } : {});
  }

  /* ================= password hashing (cliente) =================
     Antes las contraseñas de los clientes se guardaban en texto plano
     dentro de STATE (visible para cualquiera con las herramientas de
     desarrollador — clic derecho → Inspeccionar — y en el propio HTML de la
     página). Ahora se guardan como hash salteado (misma técnica que ya usa
     el backend para la cuenta de administrador, ver lib/adminAuth.js:
     SHA-256 de "salt:contraseña", guardado como "salt:hashHex"), usando la
     Web Crypto API nativa del navegador — no depende de ninguna librería
     externa, así que no choca con la Content-Security-Policy del sitio. */
  function randomHex(byteLen){
    var arr = new Uint8Array(byteLen);
    (window.crypto || window.msCrypto).getRandomValues(arr);
    return Array.prototype.map.call(arr, function(b){ return b.toString(16).padStart(2,'0'); }).join('');
  }
  async function sha256Hex(str){
    var data = new TextEncoder().encode(str);
    var digestBuf = await crypto.subtle.digest('SHA-256', data);
    return Array.prototype.map.call(new Uint8Array(digestBuf), function(b){ return b.toString(16).padStart(2,'0'); }).join('');
  }
  async function hashPassword(password, salt){
    salt = salt || randomHex(16);
    var digest = await sha256Hex(salt + ':' + password);
    return salt + ':' + digest;
  }
  async function verifyPassword(password, stored){
    if(!stored || stored.indexOf(':')===-1) return false;
    var salt = stored.split(':')[0];
    var computed = await hashPassword(password, salt);
    return computed === stored;
  }
  // Migra cuentas de cliente que todavía tengan `password` en texto plano
  // (datos guardados antes de este cambio) a `passwordHash`, en segundo
  // plano y sin bloquear el render. No usa persistState() (que siempre
  // vuelve a pintar la pantalla) para no borrar algo que la persona esté
  // escribiendo justo en ese momento en el login.
  async function migrateLegacyClientPasswords(){
    var changed = false;
    for(var i=0;i<STATE.users.length;i++){
      var u = STATE.users[i];
      if(u && u.password!=null && !u.passwordHash){
        u.passwordHash = await hashPassword(u.password);
        delete u.password;
        changed = true;
      }
    }
    if(!changed) return;
    saveLocalFallbackState();
    try{
      await saveRemoteState(STATE);
      baseRemoteState = JSON.parse(JSON.stringify(STATE));
    }catch(e){ console.error(e); }
  }

  // Trae el estado compartido guardado en el backend (Vercel Blob).
  // Devuelve { state } si hay backend disponible (state puede ser null si
  // aún no se ha guardado nada), o null si el backend no responde (por
  // ejemplo, corriendo este HTML fuera de Vercel, sin las funciones /api/*).
  async function fetchRemoteState(){
    try{
      var resp = await fetch('/api/get-state', { headers: portalApiHeaders(), cache: 'no-store' });
      if(!resp.ok) return null;
      var data = await resp.json();
      if(!data || !data.ok) return null;
      return { state: data.state || null };
    }catch(e){ return null; }
  }
  async function saveRemoteState(state){
    var resp = await fetch('/api/save-state', {
      method: 'POST',
      headers: portalApiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(state)
    });
    if(!resp.ok) throw new Error('save_state_failed');
  }

  function itemsById(arr){
    var map = {};
    (arr||[]).forEach(function(x){ if(x && x.id!=null) map[x.id] = x; });
    return map;
  }

  // Proyectos: si el portal todavía no tiene lista propia, se usa la semilla.
  function projectList(){
    if(Array.isArray(STATE.projects) && STATE.projects.length) return STATE.projects;
    return PROJECT_DEFAULTS.map(function(n){ return { id:'pj-'+n.toLowerCase().replace(/[^a-z0-9]+/g,'-'), name:n, active:true }; });
  }
  // onlyActive: para el formulario de nueva solicitud. Los filtros y la
  // edición usan todos, más el valor que ya tenga la solicitud, para no
  // perder proyectos históricos.
  function projectNames(onlyActive, extra){
    var out = projectList().filter(function(p){ return onlyActive ? p.active!==false : true; })
      .map(function(p){ return p.name; });
    if(extra && out.indexOf(extra)===-1) out.push(extra);
    return out;
  }
  function projectOptionsHtml(names, selected){
    return names.map(function(p){
      return '<option value="'+esc(p)+'" '+(p===selected?'selected':'')+'>'+esc(p)+'</option>';
    }).join('');
  }
  // Fusión de 3 vías por colección (users/requests/licenseTypes), usando
  // `base` (el último snapshot conocido del backend) para distinguir
  // "esto lo borré/edité yo" de "esto lo agregó/editó otra sesión" y así no
  // perder cambios concurrentes de otro navegador al guardar los propios.
  function mergeCollection(baseArr, localArr, remoteArr){
    var base = itemsById(baseArr), local = itemsById(localArr), remote = itemsById(remoteArr);
    var resultMap = {};
    Object.keys(local).forEach(function(id){ resultMap[id] = local[id]; });
    Object.keys(remote).forEach(function(id){
      if(resultMap.hasOwnProperty(id)) return;
      if(!base.hasOwnProperty(id)){
        // Nuevo desde otra sesión (no estaba en el snapshot base): lo conservamos.
        resultMap[id] = remote[id];
      }
      // Si estaba en base pero no en local, lo borré yo intencionalmente: no se resucita.
    });
    Object.keys(resultMap).forEach(function(id){
      if(local.hasOwnProperty(id) && remote.hasOwnProperty(id) && base.hasOwnProperty(id)){
        var localTouched = JSON.stringify(local[id]) !== JSON.stringify(base[id]);
        var remoteTouched = JSON.stringify(remote[id]) !== JSON.stringify(base[id]);
        if(!localTouched && remoteTouched){ resultMap[id] = remote[id]; }
        // si ambos lo tocaron, se conserva la versión local (last-writer-wins simple).
      }
    });
    // Lo borraron en otra sesión (estaba en base y en local, pero ya no está
    // en remote) y yo no lo toqué: se elimina también de mi lado, para que un
    // tipo de licencia retirado por el administrador deje de aparecer en la
    // pestaña de un cliente que quedó abierta. Si yo sí lo edité mientras
    // tanto, se conserva mi edición (no se resucita el borrado ajeno sobre un
    // cambio local en curso).
    Object.keys(resultMap).slice().forEach(function(id){
      if(base.hasOwnProperty(id) && local.hasOwnProperty(id) && !remote.hasOwnProperty(id)){
        var localTouched = JSON.stringify(local[id]) !== JSON.stringify(base[id]);
        if(!localTouched){ delete resultMap[id]; }
      }
    });
    var order = (baseArr||[]).map(function(x){ return x.id; });
    (localArr||[]).forEach(function(x){ if(order.indexOf(x.id)===-1) order.push(x.id); });
    (remoteArr||[]).forEach(function(x){ if(order.indexOf(x.id)===-1) order.push(x.id); });
    return order.filter(function(id){ return resultMap.hasOwnProperty(id); }).map(function(id){ return resultMap[id]; });
  }

  // Object.assign pisaba settings completo, así que un destinatario recién
  // agregado se perdía si el refresco traía la versión anterior del backend.
  // Los escalares siguen la regla "gana lo local si lo cambié", y notifyEmails
  // se fusiona por id como el resto de las colecciones.
  function mergeSettings(baseS, localS, remoteS){
    var base = baseS || {}, local = localS || {}, remote = remoteS || {};
    var out = Object.assign({}, remote, local);
    Object.keys(remote).forEach(function(k){
      if(k === 'notifyEmails') return;
      var localTouched = JSON.stringify(local[k]) !== JSON.stringify(base[k]);
      if(!localTouched) out[k] = remote[k];
    });
    out.notifyEmails = mergeCollection(base.notifyEmails, local.notifyEmails, remote.notifyEmails);
    return out;
  }

  // Sin esto, una pestaña que quedó abierta (ej. un cliente con el
  // formulario de "Nueva solicitud" abierto) sigue mostrando los precios/tipos
  // de licencia con los que cargó la página, aunque el administrador los
  // haya actualizado después — no hay nada que la haga volver a preguntarle
  // al backend. Refrescamos en segundo plano (al volver a la pestaña, al
  // enfocar la ventana, y cada 30s mientras está visible) y fusionamos con
  // mergeCollection para no pisar un cambio local todavía no guardado.
  async function refreshFromRemoteIfIdle(){
    if(!stateBackendAvailable) return;
    try{
      var remoteRes = await fetchRemoteState();
      var remote = remoteRes && remoteRes.state;
      if(!remote) return;
      var base = baseRemoteState || remote;
      STATE.users = mergeCollection(base.users, STATE.users, remote.users);
      STATE.requests = mergeCollection(base.requests, STATE.requests, remote.requests);
      STATE.licenseTypes = mergeCollection(base.licenseTypes, STATE.licenseTypes, remote.licenseTypes);
      STATE.projects = mergeCollection(base.projects, STATE.projects, remote.projects);
      if(remote.settings) STATE.settings = mergeSettings((baseRemoteState||{}).settings, STATE.settings, remote.settings);
      baseRemoteState = JSON.parse(JSON.stringify(remote));
      saveLocalFallbackState();
      render();
    }catch(e){ console.error(e); }
  }

  // Trae y fusiona el estado del backend sin repintar: se usa justo antes de
  // validar un login para que la contraseña que acaba de poner el admin ya
  // valga aunque esta pestaña se haya abierto antes del cambio.
  async function syncStateFromBackend(){
    if(!stateBackendAvailable) return;
    try{
      var remoteRes = await fetchRemoteState();
      var remote = remoteRes && remoteRes.state;
      if(!remote) return;
      var base = baseRemoteState || remote;
      STATE.users = mergeCollection(base.users, STATE.users, remote.users);
      STATE.requests = mergeCollection(base.requests, STATE.requests, remote.requests);
      STATE.licenseTypes = mergeCollection(base.licenseTypes, STATE.licenseTypes, remote.licenseTypes);
      STATE.projects = mergeCollection(base.projects, STATE.projects, remote.projects);
      if(remote.settings) STATE.settings = mergeSettings((baseRemoteState||{}).settings, STATE.settings, remote.settings);
      baseRemoteState = JSON.parse(JSON.stringify(remote));
      saveLocalFallbackState();
    }catch(e){ console.error(e); }
  }

  // Devuelve true solo si el cambio quedó guardado en el backend compartido.
  async function persistState(){
    saveUiState();
    if(!artifactCap){
      if(stateBackendAvailable){
        try{
          // Antes de guardar, traemos lo último del backend y fusionamos
          // (en vez de pisarlo) para no perder cambios hechos casi al mismo
          // tiempo desde otro navegador/dispositivo (ej. un cliente
          // enviando una solicitud mientras el admin aprueba otra).
          var remoteRes = await fetchRemoteState();
          var remote = remoteRes && remoteRes.state;
          if(remote){
            var base = baseRemoteState || remote;
            STATE.users = mergeCollection(base.users, STATE.users, remote.users);
            STATE.requests = mergeCollection(base.requests, STATE.requests, remote.requests);
            STATE.licenseTypes = mergeCollection(base.licenseTypes, STATE.licenseTypes, remote.licenseTypes);
            STATE.projects = mergeCollection(base.projects, STATE.projects, remote.projects);
          }
          await saveRemoteState(STATE);
          baseRemoteState = JSON.parse(JSON.stringify(STATE));
          saveLocalFallbackState();
          render();
          return true;
        }catch(err){
          console.error(err);
          // Si el backend falla justo en este guardado, al menos no perdemos
          // el cambio: queda en localStorage de este navegador.
          saveLocalFallbackState();
          showToast('No se pudo sincronizar con el servidor; el cambio quedó guardado solo en este navegador.', 'error');
          return false;
        }
      }
      // Sin backend disponible (por ejemplo, corriendo este HTML fuera de
      // Vercel): fallback a localStorage de este navegador. NOTE: esto NO
      // sincroniza entre dispositivos/navegadores.
      saveLocalFallbackState();
      return false;
    }
    try{
      var res = await fetch(location.href, {cache:'no-store'});
      var raw = await res.text();
      var marker = /<script id="app-state" type="application\/json">[\s\S]*?<\/script>/;
      if(!marker.test(raw)){ console.warn('state marker not found'); return false; }
      var payload = JSON.stringify(STATE).replace(/</g, '\\u003c');
      var newHtml = raw.replace(marker, '<script id="app-state" type="application/json">' + payload + '</' + 'script>');
      await artifactCap.publish(newHtml);
      return true;
    }catch(err){
      if(err && err.code === 'conflict') return false;
      if(err && (err.code === 'not_writer' || err.code === 'not_granted')){
        showToast('No tienes permiso de edición sobre esta página. Pide acceso de editor al dueño del enlace.', 'error');
        return false;
      }
      console.error(err);
      showToast('No se pudo guardar el cambio. Intenta de nuevo.', 'error');
      return false;
    }
  }

  function commit(mutator){
    mutator(STATE);
    render();
    persistState();
  }

  // Igual que commit() pero espera el guardado y dice si llegó al backend
  // compartido: se usa donde confirmar en falso rompe algo (credenciales).
  async function commitSynced(mutator){
    mutator(STATE);
    render();
    return await persistState();
  }

  async function downloadCsv(filename, csvText){
    if(!downloadsCap){
      // Outside the Claude artifact runtime (e.g. hosted standalone) fall back
      // to a plain browser download via a Blob + temporary link.
      try{
        var blob = new Blob(['﻿' + csvText], {type:'text/csv;charset=utf-8'});
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
        showToast('Descarga iniciada.', 'success');
      }catch(e){
        showToast('No se pudo generar la descarga.', 'error');
      }
      return;
    }
    try{
      await downloadsCap.save({ filename: filename, data: '﻿' + csvText });
      showToast('Descarga iniciada.', 'success');
    }catch(err){
      if(err && err.code === 'declined') return;
      showToast('No se pudo generar la descarga.', 'error');
    }
  }

  // Descarga un archivo binario (usado para el .xlsx del Reporte) via Blob +
  // link temporal. No usa downloadsCap: ese capability solo maneja texto y
  // este portal, desplegado en Vercel, siempre corre como navegador normal.
  function downloadBinary(filename, arrayBuffer, mime){
    try{
      var blob = new Blob([arrayBuffer], {type: mime});
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
      showToast('Descarga iniciada.', 'success');
    }catch(e){
      showToast('No se pudo generar la descarga.', 'error');
    }
  }

  /* ================= login ================= */
  async function tryLogin(username, password){
    if(loginRole==='admin'){
      // La cuenta de administrador se valida contra el backend persistente
      // (Vercel Blob) cuando está disponible, para que el restablecimiento
      // de contraseña funcione desde cualquier navegador/dispositivo. Si ese
      // backend no existe en este hosting (p.ej. dentro del artifact de
      // Claude), caemos de vuelta a la validación local de siempre.
      var verified = null;
      try{
        var resp = await fetch('/api/verify-admin-login', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, PORTAL_API_TOKEN ? { 'x-portal-token': PORTAL_API_TOKEN } : {}),
          body: JSON.stringify({ username: username, password: password })
        });
        if(resp.ok){ var data = await resp.json(); verified = !!data.ok; }
      }catch(e){ /* sin backend en este hosting, seguimos con el fallback local */ }

      if(verified===true){
        var adminLocal = STATE.users.find(function(x){ return x.role==='admin'; }) || { id:'u-admin', username: username, role:'admin', name:'Administrador Moventi', active:true };
        if(!adminLocal.active){ loginError = 'Esta cuenta está bloqueada. Contacta al administrador.'; render(); return; }
        loginError = '';
        setCurrentUser(adminLocal);
        adminTab = 'solicitudes';
        render();
        return;
      }
      if(verified===false){
        loginError = 'Usuario o contraseña incorrectos para el perfil seleccionado.';
        render();
        return;
      }
      // verified === null: no había backend disponible, seguimos abajo con la validación local.
    }
    // El admin pudo cambiar la contraseña después de que esta pestaña cargó.
    await syncStateFromBackend();
    var u = STATE.users.find(function(x){ return x.username===username && x.role===loginRole; });
    var ok = false;
    if(u && u.passwordHash) ok = await verifyPassword(password, u.passwordHash);
    else if(u && u.password!=null) ok = (u.password===password); // cuenta aún no migrada al hash
    if(!u || !ok){ loginError = 'Usuario o contraseña incorrectos para el perfil seleccionado.'; render(); return; }
    if(!u.active){ loginError = 'Esta cuenta está bloqueada. Contacta al administrador.'; render(); return; }
    // Si la cuenta todavía tenía la contraseña en texto plano, aprovechamos
    // este login exitoso para migrarla al hash de una vez (sin esperar a
    // que el administrador abra la pestaña de Clientes).
    if(!u.passwordHash && u.password!=null){
      hashPassword(password).then(function(h){
        u.passwordHash = h;
        delete u.password;
        saveLocalFallbackState();
        saveRemoteState(STATE).then(function(){ baseRemoteState = JSON.parse(JSON.stringify(STATE)); }).catch(function(e){ console.error(e); });
      });
    }
    loginError = '';
    setCurrentUser(u);
    adminTab = 'solicitudes';
    render();
  }

  function renderLogin(){
    var isAdmin = ENTRY_MODE==='admin';
    // foto distinta por modo de entrada (CSS no conoce el modo)
    var photo = isAdmin ? '/assets/login-office-admin.jpg' : '/assets/login-office.jpg';
    return '' +
    '<div class="login-screen-v2"><div class="login-card">' +
      '<div class="login-pane login-pane-form">' +
        '<div class="login-pane-topbar">' +
          '<div class="logo"><span class="dot"></span>moventi</div>' +
        '</div>' +
        '<div class="login-pane-form-inner">' +
          '<h1 class="login-h1">Inicia sesión</h1>' +
          '<p class="login-sub">' + (isAdmin ? 'Ingresa para continuar al panel de administración.' : 'Ingresa para continuar al portal de licencias.') + '</p>' +
          '<form onsubmit="App.submitLogin(event)">' +
            '<div class="login-field">' +
              '<label for="login-username">Usuario</label>' +
              '<div class="login-input-wrap">'+fieldIcon('user')+'<input id="login-username" name="username" type="text" autocomplete="username" autocorrect="off" autocapitalize="none" spellcheck="false" required autofocus /></div>' +
            '</div>' +
            '<div class="login-field">' +
              '<label for="login-password">Contraseña</label>' +
              '<div class="login-input-wrap">'+fieldIcon('lock')+
                '<input id="login-password" name="password" type="password" autocomplete="current-password" required enterkeyhint="go" />' +
                '<button type="button" class="login-reveal" aria-label="Mostrar la contraseña en pantalla" aria-pressed="false" onclick="App.toggleLoginPassword(this)">'+eyeIcon(false)+'</button>' +
              '</div>' +
            '</div>' +
            '<button class="btn btn-primary login-submit" type="submit">Ingresar</button>' +
          '</form>' +
          (loginError ? '<div class="login-error" role="alert">'+esc(loginError)+'</div>' : '') +
          (loginRole==='admin' ? renderForgotPasswordBlock() : '') +
        '</div>' +
      '</div>' +
      '<div class="login-pane login-pane-image'+(isAdmin?' login-pane-image--admin':'')+'" style="background-image:url(\''+photo+'\')" role="img" aria-label="'+(isAdmin?'Equipo de Moventi en una sesión de trabajo':'Equipo de Moventi colaborando en la oficina')+'">' +
        '<button type="button" class="theme-toggle theme-toggle-over" onclick="App.toggleTheme()">'+themeIcon()+'<span>'+(currentTheme==='dark'?'Modo claro':'Modo oscuro')+'</span></button>' +
      '</div>' +
    '</div></div>';
  }

  function renderForgotPasswordBlock(){
    if(!forgotPasswordOpen){
      return '<p class="login-forgot">' +
        '<a href="#" onclick="App.startForgotPassword(event)">¿Olvidaste tu contraseña?</a>' +
        '</p>';
    }
    if(forgotPasswordSent){
      return '<div class="notice-box" style="margin-top:1rem">' + noticeIconSvg() +
        '<span>Si el usuario existe, enviamos un enlace para restablecer la contraseña al correo registrado. Revisa la bandeja (y spam) en los próximos minutos.</span></div>' +
        '<p style="margin-top:.6rem"><a href="#" onclick="App.cancelForgotPassword(event)" style="font-size:.82rem;color:var(--ink-muted);text-decoration:underline">Volver al inicio de sesión</a></p>';
    }
    return '<div class="card card-pad" style="margin-top:1rem;padding:1rem">' +
      '<div class="card-title" style="font-size:.92rem">Restablecer contraseña</div>' +
      '<form onsubmit="App.submitForgotPassword(event)" class="stack">' +
        '<div class="field"><label>Usuario administrador</label><input name="username" required /></div>' +
        '<div style="display:flex;gap:.6rem">' +
          '<button class="btn btn-primary btn-sm" type="submit" '+(forgotPasswordBusy?'disabled':'')+'>'+(forgotPasswordBusy?'Enviando…':'Enviar enlace')+'</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" onclick="App.cancelForgotPassword(event)">Cancelar</button>' +
        '</div>' +
      '</form>' +
    '</div>';
  }

  function renderResetPasswordScreen(){
    var st = resetPasswordState;
    var body;
    if(st.done){
      body = '<div class="notice-box">' + noticeIconSvg() + '<span>Tu contraseña fue actualizada. Ya puedes iniciar sesión con la nueva contraseña.</span></div>' +
        '<button class="btn btn-primary" style="margin-top:1rem;width:100%" onclick="App.goToLoginAfterReset()">Ir a iniciar sesión</button>';
    } else {
      var errMsg = '';
      if(st.error==='invalid_token') errMsg = 'El enlace no es válido. Solicita uno nuevo desde la pantalla de inicio de sesión.';
      else if(st.error==='expired_token') errMsg = 'Este enlace expiró (vale por 30 minutos). Solicita uno nuevo.';
      else if(st.error==='invalid_input') errMsg = 'La contraseña debe tener al menos 8 caracteres y ambas deben coincidir.';
      else if(st.error) errMsg = 'Ocurrió un error al restablecer la contraseña. Intenta nuevamente.';
      body = '<form onsubmit="App.submitResetPassword(event)" class="stack">' +
        '<div class="field"><label>Nueva contraseña</label><input name="newPassword" type="password" minlength="8" required /></div>' +
        '<div class="field"><label>Confirmar contraseña</label><input name="confirmPassword" type="password" minlength="8" required /></div>' +
        (errMsg ? '<div class="login-error">'+esc(errMsg)+'</div>' : '') +
        '<button class="btn btn-primary" style="margin-top:.4rem;width:100%" type="submit" '+(st.busy?'disabled':'')+'>'+(st.busy?'Guardando…':'Guardar nueva contraseña')+'</button>' +
      '</form>';
    }
    return '' +
    '<div class="login-screen"><div class="login-inner">' +
      '<div class="login-topbar">' +
        '<div class="logo"><span class="dot"></span>moventi</div>' +
      '</div>' +
      '<div class="login-hero">' +
        '<div>' +
          '<div class="badge"><span class="pill-dot"></span>MOVENTI</div>' +
          '<h1>Nueva<br><span>contraseña</span></h1>' +
          '<p class="sub">Define una nueva contraseña para la cuenta de administrador.</p>' +
        '</div>' +
        '<div class="orb"></div>' +
      '</div>' +
      '<div class="login-form-side">' +
        '<div class="login-box">' +
          '<h2 style="font-size:1.3rem;font-weight:800;margin-bottom:1rem">Restablecer contraseña</h2>' +
          body +
        '</div>' +
      '</div>' +
    '</div></div>';
  }

  /* ================= shell ================= */
  function topbar(user, roleLabel){
    return '<div class="topbar">' +
      '<div class="logo"><span class="dot"></span>moventi<span style="font-weight:500;color:var(--ink-muted);font-size:.85rem;margin-left:.6rem">Portal de licencias</span></div>' +
      '<div class="topbar-right">' +
        '<button type="button" class="theme-toggle" onclick="App.toggleTheme()">'+themeIcon()+'<span>'+(currentTheme==='dark'?'Modo claro':'Modo oscuro')+'</span></button>' +
        '<span class="role-chip">'+esc(roleLabel)+'</span>' +
        '<span class="user-name">'+esc(user.name)+'</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="App.logout()">Cerrar sesión</button>' +
      '</div>' +
    '</div>';
  }

  /* ================= client view ================= */
  function renderClient(user){
    var myReqs = STATE.requests.filter(function(r){ return r.clientUsername===user.username; })
      .sort(function(a,b){ return new Date(b.requestedAt)-new Date(a.requestedAt); });
    var activeTypes = STATE.licenseTypes.filter(function(t){ return t.active; });

    // Proyectos que el cliente realmente usó (no toda la lista global).
    var misProyectos = [];
    myReqs.forEach(function(r){ if(r.project && misProyectos.indexOf(r.project)===-1) misProyectos.push(r.project); });
    misProyectos.sort();
    if(clientFilterProject!=='todos' && misProyectos.indexOf(clientFilterProject)===-1) clientFilterProject = 'todos';
    var visibles = clientFilterProject==='todos'
      ? myReqs
      : myReqs.filter(function(r){ return r.project===clientFilterProject; });

    // El comentario va como línea secundaria bajo el tipo: así la tabla entra
    // completa en la columna sin barra de desplazamiento.
    var rows = visibles.map(function(r){
      return '<tr>' +
        '<td class="lt-name">'+esc(r.licenseTypeName)+
          (r.note ? '<div class="cell-note" title="'+esc(r.note)+'">'+esc(r.note)+'</div>' : '')+'</td>' +
        '<td style="color:var(--ink-subtle)">'+esc(r.project||'—')+'</td>' +
        '<td class="num">'+(r.quantity||1)+'</td>' +
        '<td><span class="pill '+statusCls(r.status)+'">'+r.status+'</span></td>' +
        '<td class="num cell-date">'+fmtDateShort(r.requestedAt)+'</td>' +
        '<td class="num cell-date">'+fmtDateShort(r.neededFrom)+'</td>' +
        '<td class="num cell-date">'+(r.activatedAt ? fmtDateShort(r.activatedAt) : '—')+'</td>' +
      '</tr>';
    }).join('');

    var filtroProyecto = misProyectos.length>1
      ? '<div class="field" style="max-width:230px"><label>Proyecto</label><select onchange="App.setClientProject(this.value)">' +
          '<option value="todos"'+(clientFilterProject==='todos'?' selected':'')+'>Todos</option>' +
          misProyectos.map(function(p){
            return '<option value="'+esc(p)+'"'+(clientFilterProject===p?' selected':'')+'>'+esc(p)+'</option>';
          }).join('') +
        '</select></div>'
      : '';

    var options = activeTypes.map(function(t){
      return '<option value="'+t.id+'">'+esc(t.name)+'</option>';
    }).join('');
    var projectOptions = projectOptionsHtml(projectNames(true));

    return topbar(user, 'Cliente') +
    '<div class="app-body">' +
      '<div class="main-area">' +
        '<div class="section-head"><h2>Hola, '+esc(user.name)+'</h2><p>Registra nuevas solicitudes de licencia y revisa el estado de las anteriores.</p></div>' +
        '<div class="grid-2 grid-client">' +
          '<div class="card card-pad">' +
            '<div class="card-title">Nueva solicitud de licencia</div>' +
            (activeTypes.length===0
              ? '<p class="empty-note">No hay tipos de licencia disponibles actualmente. Contacta al administrador.</p>'
              : '<form onsubmit="App.submitRequest(event)" class="stack">' +
                '<div class="field-row">' +
                  '<div class="field"><label>Tipo de licencia</label><select name="licenseTypeId" required>'+options+'</select></div>' +
                  '<div class="field"><label>Cantidad de licencias</label><div class="num-field"><input type="number" id="new-qty-input" name="quantity" min="1" step="1" value="1" required />'+numStepper('new-qty-input',1)+'</div></div>' +
                '</div>' +
                '<div class="field-row">' +
                  '<div class="field"><label>Proyecto/servicio al que se vincula la cuenta</label><select name="project" required>'+projectOptions+'</select></div>' +
                  '<div class="field"><label>¿Desde cuándo se necesita habilitada?</label><input type="date" name="neededFrom" min="'+todayYmd()+'" required /></div>' +
                '</div>' +
                '<div class="field"><label>Comentario (opcional)</label><textarea name="note" placeholder="Detalle adicional para el administrador"></textarea></div>' +
                '<p class="hint">No es necesario indicar una fecha de vencimiento. La fecha de la solicitud y la de autorización quedan registradas automáticamente.</p>' +
                '<div class="notice-box">' + noticeIconSvg() + '<span>Respondemos tu solicitud en un plazo máximo de <strong>24 horas</strong>.</span></div>' +
                '<button class="btn btn-primary" type="submit" style="align-self:flex-start">Enviar solicitud</button>' +
              '</form>') +
          '</div>' +
          '<div class="card card-pad">' +
            '<div class="card-title">Mis solicitudes<span style="font-weight:500;color:var(--ink-muted);font-size:.8rem">'+
              (clientFilterProject==='todos' ? myReqs.length+' registradas' : visibles.length+' de '+myReqs.length)+'</span></div>' +
            filtroProyecto +
            (myReqs.length===0 ? '<div class="table-empty">Aún no registras solicitudes.</div>' :
             visibles.length===0 ? '<div class="table-empty">No hay solicitudes de este proyecto.</div>' :
            '<div class="table-fit"><table class="table-client"><thead><tr>' +
              '<th>Tipo</th><th>Proyecto</th><th>Cant.</th><th>Estado</th>' +
              '<th>Fecha de solicitud</th><th>Fecha requerida</th><th>Fecha de activación</th>' +
            '</tr></thead><tbody>'+rows+'</tbody></table></div>') +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* ================= admin view ================= */
  function adminNav(){
    var items = [
      ['solicitudes','Solicitudes'],
      ['tipos','Tipos de licencia'],
      ['proyectos','Proyectos'],
      ['clientes','Clientes'],
      ['notificaciones','Notificaciones'],
      ['reporte','Reporte'],
      ['cuenta','Mi cuenta']
    ];
    return '<div class="side-nav">' + items.map(function(it){
      return '<div class="nav-item '+(adminTab===it[0]?'active':'')+'" onclick="App.setAdminTab(\''+it[0]+'\')"><span class="ic">'+navIcon(it[0])+'</span><span class="nav-label">'+it[1]+'</span></div>';
    }).join('') + '</div>';
  }

  // Menú desplegable de acciones por fila (Solicitudes/Reporte): agrupa los
  // botones de acción (aprobar/rechazar/editar/eliminar) detrás de un botón
  // "⋮" para que la tabla no se vea saturada de botones sueltos.
  function buildRowMenu(rowId, items){
    var isOpen = openRowMenu===rowId;
    // Posición calculada al abrir el menú (ver toggleRowMenu), en coordenadas
    // de viewport con position:fixed: así el menú no queda recortado por el
    // overflow-x:auto de la tabla (que en la práctica también recorta el eje
    // vertical) ni oculto debajo del borde inferior de la pantalla en filas
    // cercanas al final de la tabla.
    var style = '';
    if(isOpen && rowMenuPos){
      style = 'position:fixed; left:'+rowMenuPos.left+'px; ' +
        (rowMenuPos.dir==='up' ? 'bottom:'+rowMenuPos.y+'px;' : 'top:'+rowMenuPos.y+'px;');
    }
    var menu = isOpen ? (
      '<div class="row-menu-overlay" onclick="App.closeRowMenu()"></div>' +
      '<div class="row-menu" style="'+style+'">' +
        items.map(function(it){
          return '<button type="button" class="'+(it.cls||'')+'" onclick="App.closeRowMenu(); '+it.onclick+'">'+esc(it.label)+'</button>';
        }).join('') +
      '</div>'
    ) : '';
    return '<div class="row-menu-wrap">' +
      '<button type="button" class="row-menu-btn" onclick="App.toggleRowMenu(\''+rowId+'\', event)" aria-label="Acciones">&#8942;</button>' +
      menu +
    '</div>';
  }

  function renderAdminSolicitudes(){
    var clients = STATE.users.filter(function(u){ return u.role==='client'; });
    var list = STATE.requests.slice().sort(function(a,b){ return new Date(b.requestedAt)-new Date(a.requestedAt); });
    if(solFilter.cliente!=='todos') list = list.filter(function(r){ return r.clientUsername===solFilter.cliente; });
    if(solFilter.estado!=='todos') list = list.filter(function(r){ return r.status===solFilter.estado; });
    if(solFilter.proyecto!=='todos') list = list.filter(function(r){ return r.project===solFilter.proyecto; });

    var pendingIngram = STATE.requests.filter(puedeEnviarse);

    var allTypes = STATE.licenseTypes;
    var rows = list.map(function(r){
      var isEditing = editingRequestId===r.id;

      if(isEditing){
        var typeOptions = allTypes.map(function(t){ return '<option value="'+t.id+'" '+(t.id===r.licenseTypeId?'selected':'')+'>'+esc(t.name)+'</option>'; }).join('');
        var projectOptionsEdit = projectOptionsHtml(projectNames(false, r.project), r.project);
        return '<tr class="editing-row" id="req-row-'+r.id+'">' +
          '<td></td>' +
          '<td class="num"><input class="mini-input" id="edit-reqdate-'+r.id+'" type="date" value="'+(dateOnly(r.requestedAt)||'')+'" /></td>' +
          '<td class="wrap">'+clipCell(r.clientName)+'</td>' +
          '<td class="wrap"><select class="mini-select" id="edit-type-'+r.id+'">'+typeOptions+'</select></td>' +
          '<td class="wrap"><select class="mini-select" id="edit-project-'+r.id+'">'+projectOptionsEdit+'</select></td>' +
          '<td class="num"><div class="num-field"><input class="mini-input" id="edit-qty-'+r.id+'" type="number" min="1" step="1" value="'+(r.quantity||1)+'" />'+numStepper('edit-qty-'+r.id,1)+'</div></td>' +
          '<td class="num"><input class="mini-input" id="edit-date-'+r.id+'" type="date" value="'+(r.neededFrom||'')+'" /></td>' +
          '<td class="num">'+money(reqTotal(r))+'</td>' +
          '<td><span class="pill '+statusCls(r.status)+'">'+r.status+'</span></td>' +
          '<td class="num"><input class="mini-input" id="edit-actdate-'+r.id+'" type="date" value="'+(dateOnly(r.activatedAt)||'')+'" /></td>' +
          '<td>—</td>' +
          '<td><button class="btn btn-success btn-sm" onclick="App.saveEditRequest(\''+r.id+'\')">Guardar</button> <button class="btn btn-subtle btn-sm" onclick="App.cancelEditRequest()">Cancelar</button></td>' +
        '</tr>';
      }

      var menuItems = [];
      if(r.status==='pendiente'){
        menuItems.push({label:'Rechazar', cls:'rm-danger', onclick:"App.reviewRequest('"+r.id+"','rechazado')"});
      }
      menuItems.push({label:'Editar', onclick:"App.startEditRequest('"+r.id+"')"});
      menuItems.push({label:'Eliminar', cls:'rm-danger', onclick:"App.removeRequest('"+r.id+"')"});
      var actions = (r.status==='en proceso'
        ? '<button class="btn btn-success btn-sm" onclick="App.markActivated(\''+r.id+'\')">Notificar activación</button> '
        : '') +
        buildRowMenu(r.id, menuItems);
      var checkbox = puedeEnviarse(r)
        ? '<input type="checkbox" '+(selectedForIngram.has(r.id)?'checked':'')+' onchange="App.toggleIngramSelect(\''+r.id+'\', this.checked)" />'
        : '';
      var notified = r.status==='rechazado' ? '<span style="color:var(--ink-subtle)">—</span>'
        : (r.notifiedToIngram
          ? '<span class="pill status-enviado">Enviado</span>'
          : '<span class="pill status-sinenviar">Pendiente</span>');
      return '<tr id="req-row-'+r.id+'">' +
        '<td>'+checkbox+'</td>' +
        '<td class="num">'+fmtDateShort(r.requestedAt)+'</td>' +
        '<td class="wrap">'+clipCell(r.clientName)+'</td>' +
        '<td class="wrap">'+clipCell(r.licenseTypeName)+'</td>' +
        '<td class="wrap">'+clipCell(r.project||'—')+'</td>' +
        '<td class="num">'+(r.quantity||1)+'</td>' +
        '<td class="num">'+fmtDateShort(r.neededFrom)+'</td>' +
        '<td class="num">'+money(reqTotal(r))+'</td>' +
        '<td><span class="pill '+statusCls(r.status)+'">'+r.status+'</span></td>' +
        '<td class="num">'+(r.activatedAt ? fmtDateShort(r.activatedAt) : '—')+'</td>' +
        '<td>'+notified+'</td>' +
        '<td>'+actions+'</td>' +
      '</tr>';
    }).join('');

    var histPanel = '<div class="card card-pad" style="margin-bottom:1rem">' +
      '<div class="card-title">Cargar histórico (solicitudes de meses pasados)' +
        '<button type="button" class="btn btn-subtle btn-sm" style="margin-left:auto" onclick="App.toggleImportHist()">'+(importHistOpen?'Cerrar':'Abrir')+'</button>' +
      '</div>' +
      (!importHistOpen ? '<p class="hint">Sube un CSV o carga una solicitud a mano para poner al día la BD con licencias ya activas de meses anteriores.</p>' :
        '<p class="hint">Columnas del CSV (separadas por ; o ,): '+HIST_CSV_HEADER.join(' · ')+'. Si el cliente, tipo o proyecto no existen, se crean automáticamente.</p>' +
        '<div style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin:.4rem 0">' +
          '<button type="button" class="btn btn-ghost btn-sm" onclick="App.downloadHistTemplate()">Descargar plantilla CSV</button>' +
          '<input type="file" accept=".csv,text/csv" id="hist-csv-input" onchange="App.handleImportHistFile(this)" />' +
        '</div>' +
        (importHistFileName ? '<p class="hint">Archivo: '+esc(importHistFileName)+'</p>' : '') +
        (importHistErrors.length ? '<div class="notice-box" style="border-color:var(--danger,#e5484d)"><span><strong>'+importHistErrors.length+' fila'+(importHistErrors.length===1?'':'s')+' con error'+(importHistErrors.length===1?'':'es')+' (no se importarán):</strong><br>'+importHistErrors.map(esc).join('<br>')+'</span></div>' : '') +
        (importHistRows && importHistRows.length ?
          '<p class="hint"><strong>'+importHistRows.length+' fila'+(importHistRows.length===1?'':'s')+' lista'+(importHistRows.length===1?'':'s')+' para importar.</strong></p>' +
          '<div style="display:flex;gap:.6rem">' +
            '<button type="button" class="btn btn-primary btn-sm" '+(importHistBusy?'disabled':'')+' onclick="App.confirmImportHist()">'+(importHistBusy?'Importando…':'Confirmar importación')+'</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" onclick="App.cancelImportHist()">Cancelar</button>' +
          '</div>'
        : '') +
        '<hr style="border:none;border-top:1px solid var(--border);margin:1rem 0" />' +
        '<button type="button" class="btn btn-subtle btn-sm" onclick="App.toggleManualHist()">'+(manualHistOpen?'Ocultar formulario manual':'Cargar una solicitud a mano')+'</button>' +
        (manualHistOpen ?
          '<form onsubmit="App.submitManualHist(event)" class="stack" style="margin-top:.6rem">' +
            '<div class="field"><label>Cliente (nombre)</label><input name="cliente" list="hist-clientes" required /><datalist id="hist-clientes">'+clients.map(function(c){ return '<option value="'+esc(c.name)+'">'; }).join('')+'</datalist></div>' +
            '<div class="field"><label>Tipo de licencia</label><input name="tipo" list="hist-tipos" required /><datalist id="hist-tipos">'+allTypes.map(function(t){ return '<option value="'+esc(t.name)+'">'; }).join('')+'</datalist></div>' +
            '<div class="field"><label>Proyecto</label><input name="proyecto" list="hist-proyectos" /><datalist id="hist-proyectos">'+projectNames(false).map(function(p){ return '<option value="'+esc(p)+'">'; }).join('')+'</datalist></div>' +
            '<div class="field"><label>Cantidad</label><input name="cantidad" type="number" min="1" step="1" value="1" required /></div>' +
            '<div class="field"><label>Precio unitario (US$)</label><input name="precio" type="number" min="0" step="0.01" required /></div>' +
            '<div class="field"><label>Fecha de solicitud</label><input name="fSol" type="date" required /></div>' +
            '<div class="field"><label>Fecha requerida</label><input name="fReq" type="date" required /></div>' +
            '<div class="field"><label>Estado</label><select name="estado">'+ESTADOS.map(function(s){ return '<option value="'+s+'" '+(s==='activado'?'selected':'')+'>'+s+'</option>'; }).join('')+'</select></div>' +
            '<div class="field"><label>Fecha de activación (si aplica)</label><input name="fAct" type="date" /></div>' +
            '<div class="field"><label>Gestionado por (opcional)</label><input name="gestor" placeholder="Nombre del operador" /></div>' +
            '<button class="btn btn-primary" type="submit" style="align-self:flex-start">Agregar solicitud histórica</button>' +
          '</form>'
        : '')
      ) +
    '</div>';

    return '<div class="section-head"><h2>Solicitudes</h2><p>Valida las solicitudes de licencia enviadas por tus clientes y envía por correo las que ya están aprobadas para su gestión.</p></div>' +
    histPanel +
    '<div class="settings-bar">' +
      '<div class="field"><label>Correo de contacto para el envío</label><input type="email" value="'+esc(STATE.settings.ingramEmail||'')+'" placeholder="contacto@proveedor.com" onchange="App.setIngramEmail(this.value)" /></div>' +
      '<div class="field"><label>Copia (CC), opcional</label><input type="text" value="'+esc(STATE.settings.ingramCc||'')+'" placeholder="correo1@empresa.com, correo2@empresa.com" onchange="App.setIngramCc(this.value)" /></div>' +
      '<p class="hint">A este correo se enviarán las solicitudes de habilitación de licencias seleccionadas abajo. Puedes agregar varios correos en copia separados por coma.</p>' +
      '<button type="button" class="btn btn-subtle btn-sm" style="flex-basis:100%;align-self:flex-start" onclick="App.toggleEmailTplEditor()">'+(emailTplOpen?'Ocultar mensaje del correo':'Personalizar mensaje del correo')+'</button>' +
      (emailTplOpen ?
        '<div class="field" style="flex-basis:100%"><label>Asunto</label><input id="email-subject-input" value="'+esc(STATE.settings.emailSubjectTemplate||'')+'" onchange="App.setEmailSubject(this.value)" /></div>' +
        '<div class="field" style="flex-basis:100%"><label>Mensaje</label><textarea id="email-body-input" rows="6" onchange="App.setEmailBody(this.value)">'+esc(STATE.settings.emailBodyTemplate||'')+'</textarea></div>' +
        '<p class="hint" style="flex-basis:100%">Campos dinámicos disponibles: <code>{{detalle}}</code> (lista de licencias aprobadas seleccionadas), <code>{{cantidad}}</code> (número de solicitudes), <code>{{unidad}}</code> ("solicitud"/"solicitudes"), <code>{{admin}}</code> (tu nombre), <code>{{fecha}}</code> (fecha de envío).</p>' +
        '<button type="button" class="btn btn-ghost btn-sm" style="flex-basis:100%;align-self:flex-start" onclick="App.resetEmailTemplate()">Restaurar mensaje predeterminado</button>'
        : '') +
    '</div>' +
    '<div class="ingram-bar">' +
      '<button class="btn btn-subtle btn-sm" onclick="App.selectAllPendingIngram()" '+(pendingIngram.length===0?'disabled':'')+'>Seleccionar sin enviar ('+pendingIngram.length+')</button>' +
      '<span class="count">'+selectedForIngram.size+' seleccionada'+(selectedForIngram.size===1?'':'s')+'</span>' +
      '<button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="App.sendToIngram()" '+(selectedForIngram.size===0?'disabled':'')+'>Enviar solicitud por correo</button>' +
    '</div>' +
    '<p class="hint">El correo lleva la fecha desde la que se necesita cada licencia, así que puedes enviarlo apenas apruebes la solicitud.</p>' +
    '<div class="toolbar">' +
      '<div class="field"><label>Cliente</label><select onchange="App.setSolFilter(\'cliente\', this.value)">' +
        '<option value="todos">Todos</option>' + clients.map(function(c){ return '<option value="'+c.username+'" '+(solFilter.cliente===c.username?'selected':'')+'>'+esc(c.name)+'</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label>Estado</label><select onchange="App.setSolFilter(\'estado\', this.value)">' +
        ['todos'].concat(ESTADOS).map(function(s){ return '<option value="'+s+'" '+(solFilter.estado===s?'selected':'')+'>'+(s==='todos'?'Todos':s)+'</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label>Proyecto</label><select onchange="App.setSolFilter(\'proyecto\', this.value)">' +
        '<option value="todos">Todos</option>' + projectOptionsHtml(projectNames(false), solFilter.proyecto) +
      '</select></div>' +
    '</div>' +
    '<div class="card">' +
      (list.length===0 ? '<div class="table-empty">No hay solicitudes con estos filtros.</div>' :
      '<div class="table-wrap no-scrollbar"><table class="table-dense"><thead><tr><th></th><th>Fecha de solicitud</th><th>Cliente</th><th>Tipo</th><th>Proyecto</th><th>Cantidad</th><th>Fecha requerida</th><th>Precio</th><th>Estado</th><th>Fecha de activación</th><th>Envío</th><th>Acción</th></tr></thead><tbody>'+rows+'</tbody></table></div>') +
    '</div>';
  }

  function renderAdminTipos(){
    var rows = STATE.licenseTypes.map(function(t){
      var usedCount = STATE.requests.filter(function(r){ return r.licenseTypeId===t.id; }).length;
      return '<tr>' +
        '<td class="lt-name">'+esc(t.name)+'</td>' +
        '<td class="num">' +
          '<div class="num-field"><input class="price-input" id="price-input-'+t.id+'" type="number" min="0" step="0.01" value="'+t.price+'" onchange="App.setTypePrice(\''+t.id+'\', this.value)" />'+numStepper('price-input-'+t.id,0)+'</div>' +
        '</td>' +
        '<td><span class="pill status-'+(t.active?'activo':'bloqueado')+'">'+(t.active?'activo':'bloqueado')+'</span></td>' +
        '<td style="color:var(--ink-subtle)">'+usedCount+' solicitud'+(usedCount===1?'':'es')+'</td>' +
        '<td>' +
          '<button class="btn btn-subtle btn-sm" onclick="App.toggleTypeActive(\''+t.id+'\')">'+(t.active?'Bloquear':'Activar')+'</button> ' +
          '<button class="btn btn-danger btn-sm" '+(usedCount>0?'disabled title="Tiene solicitudes asociadas"':'onclick="App.removeType(\''+t.id+'\')"')+'>Eliminar</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    return '<div class="section-head"><h2>Tipos de licencia</h2><p>Define qué licencias pueden solicitar tus clientes y a qué precio.</p></div>' +
    '<div class="grid-2">' +
      '<div class="card card-pad">' +
        '<div class="card-title">Añadir tipo de licencia</div>' +
        '<form onsubmit="App.addType(event)" class="stack">' +
          '<div class="field"><label>Nombre</label><input name="name" placeholder="Ej. Google Workspace Business Plus" required /></div>' +
          '<div class="field"><label>Precio (US$)</label><div class="num-field"><input id="new-type-price" name="price" type="number" min="0" step="0.01" value="0" required />'+numStepper('new-type-price',0)+'</div></div>' +
          '<button class="btn btn-primary" type="submit" style="align-self:flex-start">Añadir</button>' +
        '</form>' +
      '</div>' +
      '<div class="card">' +
        (STATE.licenseTypes.length===0 ? '<div class="table-empty">Aún no hay tipos de licencia.</div>' :
        '<div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Precio</th><th>Estado</th><th>Uso</th><th>Acciones</th></tr></thead><tbody>'+rows+'</tbody></table></div>') +
      '</div>' +
    '</div>';
  }

  // Proyectos/servicios administrables: lo que se agregue aquí aparece de
  // inmediato en el formulario del cliente y en los filtros.
  function renderAdminProyectos(){
    var rows = projectList().map(function(p){
      var usedCount = STATE.requests.filter(function(r){ return r.project===p.name; }).length;
      var activo = p.active!==false;
      return '<tr>' +
        '<td class="lt-name">'+esc(p.name)+'</td>' +
        '<td><span class="pill status-'+(activo?'activo':'bloqueado')+'">'+(activo?'activo':'bloqueado')+'</span></td>' +
        '<td style="color:var(--ink-subtle)">'+usedCount+' solicitud'+(usedCount===1?'':'es')+'</td>' +
        '<td>' +
          '<button class="btn btn-subtle btn-sm" onclick="App.toggleProjectActive(\''+p.id+'\')">'+(activo?'Ocultar':'Activar')+'</button> ' +
          '<button class="btn btn-danger btn-sm" '+(usedCount>0?'disabled title="Tiene solicitudes asociadas"':'onclick="App.removeProject(\''+p.id+'\')"')+'>Eliminar</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    return '<div class="section-head"><h2>Proyectos</h2><p>Los proyectos/servicios a los que el cliente puede vincular la cuenta al pedir una licencia.</p></div>' +
    '<div class="grid-2">' +
      '<div class="card card-pad">' +
        '<div class="card-title">Añadir proyecto</div>' +
        '<form onsubmit="App.addProject(event)" class="stack">' +
          '<div class="field"><label>Nombre</label><input name="name" placeholder="Ej. Ligo-QA" required /></div>' +
          '<button class="btn btn-primary" type="submit" style="align-self:flex-start">Añadir</button>' +
        '</form>' +
        '<p class="hint">"Ocultar" lo saca del formulario del cliente pero mantiene las solicitudes que ya lo usan.</p>' +
      '</div>' +
      '<div class="card">' +
        '<div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Estado</th><th>Uso</th><th>Acciones</th></tr></thead><tbody>'+rows+'</tbody></table></div>' +
      '</div>' +
    '</div>';
  }

  function renderAdminClientes(){
    var rows = STATE.users.filter(function(u){ return u.role==='client'; }).map(function(u){
      var reqCount = STATE.requests.filter(function(r){ return r.clientUsername===u.username; }).length;

      if(editingClientId===u.id){
        return '<tr class="editing-row">' +
          '<td><input class="mini-input" id="edit-client-name-'+u.id+'" value="'+esc(u.name)+'" /></td>' +
          '<td><input class="mini-input mono" id="edit-client-username-'+u.id+'" value="'+esc(u.username)+'" /></td>' +
          // El campo de contraseña arranca SIEMPRE vacío: la contraseña
          // actual no se guarda en texto plano en ningún lado (solo su
          // hash), así que no hay nada que precargar aquí. Si se deja
          // vacío al guardar, la contraseña no cambia.
          '<td><input class="mini-input mono" type="password" autocomplete="new-password" id="edit-client-password-'+u.id+'" value="" placeholder="Nueva contraseña (opcional)" /></td>' +
          '<td><input class="mini-input" id="edit-client-email-'+u.id+'" value="'+esc(u.email||'')+'" placeholder="correo@cliente.com" /></td>' +
          '<td></td>' +
          '<td>' +
            '<button class="btn btn-primary btn-sm" onclick="App.saveEditClient(\''+u.id+'\')">Guardar</button> ' +
            '<button class="btn btn-ghost btn-sm" onclick="App.cancelEditClient()">Cancelar</button>' +
          '</td>' +
        '</tr>';
      }

      return '<tr>' +
        '<td class="lt-name">'+esc(u.name)+'</td>' +
        '<td class="mono">'+esc(u.username)+'</td>' +
        '<td><span class="mono" style="color:var(--ink-subtle)">••••••••</span></td>' +
        '<td>'+(u.email ? esc(u.email) : '<span style="color:var(--ink-subtle)">— sin correo —</span>')+'</td>' +
        '<td><span class="pill status-'+(u.active?'activo':'bloqueado')+'">'+(u.active?'activo':'bloqueado')+'</span></td>' +
        '<td style="color:var(--ink-subtle)">'+reqCount+' solicitud'+(reqCount===1?'':'es')+'</td>' +
        '<td>' +
          '<button class="btn btn-subtle btn-sm" onclick="App.toggleUserActive(\''+u.id+'\')">'+(u.active?'Bloquear':'Activar')+'</button> ' +
          '<button class="btn btn-ghost btn-sm" onclick="App.startEditClient(\''+u.id+'\')">Editar</button> ' +
          '<button class="btn btn-danger btn-sm" '+(reqCount>0?'disabled title="Tiene solicitudes asociadas"':'onclick="App.removeUser(\''+u.id+'\')"')+'>Eliminar</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    return '<div class="section-head"><h2>Clientes</h2><p>Crea y administra las cuentas con acceso al portal.</p></div>' +
    '<div class="grid-2">' +
      '<div class="card card-pad">' +
        '<div class="card-title">Añadir cliente</div>' +
        '<form onsubmit="App.addClient(event)" class="stack">' +
          '<div class="field"><label>Nombre / empresa</label><input name="name" placeholder="Ej. Beta Consultores S.A.C." required /></div>' +
          '<div class="field"><label>Usuario</label><input name="username" placeholder="usuario de acceso" required /></div>' +
          '<div class="field"><label>Contraseña</label><input name="password" type="password" autocomplete="new-password" placeholder="contraseña inicial" required /></div>' +
          '<div class="field"><label>Correo de aviso</label><input name="email" type="email" placeholder="correo@cliente.com" /></div>' +
          '<p class="hint">A este correo se le avisa cuando su licencia queda activada. Puedes dejarlo vacío y completarlo después.</p>' +
          '<p class="hint">La contraseña se guarda encriptada (hash); ni el administrador ni nadie con las herramientas de desarrollador puede volver a verla en texto plano — solo se puede definir una nueva.</p>' +
          '<button class="btn btn-primary" type="submit" style="align-self:flex-start">Crear cuenta</button>' +
        '</form>' +
      '</div>' +
      '<div class="card">' +
        '<div class="table-wrap"><table><thead><tr><th>Cliente</th><th>Usuario</th><th>Contraseña</th><th>Correo de aviso</th><th>Estado</th><th>Uso</th><th>Acciones</th></tr></thead><tbody>'+rows+'</tbody></table></div>' +
      '</div>' +
    '</div>';
  }

  function numStepper(id, min){
    return '<span class="num-stepper">' +
      '<button type="button" tabindex="-1" onclick="App.stepNumber(\''+id+'\', 1, '+(min==null?'null':min)+')">&#9650;</button>' +
      '<button type="button" tabindex="-1" onclick="App.stepNumber(\''+id+'\', -1, '+(min==null?'null':min)+')">&#9660;</button>' +
    '</span>';
  }
  function noticeIconSvg(){
    return '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px">'+
      '<circle cx="12" cy="12" r="9"></circle>'+
      '<line x1="12" y1="8" x2="12" y2="13"></line>'+
      '<line x1="12" y1="16" x2="12.01" y2="16"></line>'+
    '</svg>';
  }

  function renderAdminNotificaciones(){
    var list = STATE.settings.notifyEmails || [];
    var rows = list.map(function(n){
      return '<tr>' +
        '<td class="lt-name">'+esc(n.name||'—')+'</td>' +
        '<td class="mono">'+esc(n.email)+'</td>' +
        '<td><button class="btn btn-danger btn-sm" onclick="App.removeNotifyEmail(\''+n.id+'\')">Eliminar</button></td>' +
      '</tr>';
    }).join('');

    // Última solicitud cuyo aviso falló: sin esto, un rechazo del envío
    // (destinatario no permitido, Gmail caído) pasaba inadvertido.
    var failed = STATE.requests.filter(function(r){ return r.notifyEmailSent === false; })
      .sort(function(a,b){ return new Date(b.requestedAt)-new Date(a.requestedAt); })[0];

    return '<div class="section-head"><h2>Notificaciones</h2><p>Elige a quién le llega el aviso automático por correo cuando un cliente registra una nueva solicitud de licencia. El correo incluye un botón para revisar y aprobar la solicitud directamente, sin tener que buscarla manualmente en el panel.</p></div>' +
    (failed ? '<div class="login-error" style="margin-bottom:1rem">El último aviso no se pudo enviar ('+esc(failed.notifyEmailError||'motivo desconocido')+') para la solicitud de '+esc(failed.clientName)+'. Revisa los destinatarios y usa "Enviar prueba".</div>' : '') +
    '<div class="grid-2">' +
      '<div class="card card-pad">' +
        '<div class="card-title">Añadir destinatario</div>' +
        '<form onsubmit="App.addNotifyEmail(event)" class="stack">' +
          '<div class="field"><label>Nombre (opcional)</label><input name="name" placeholder="Ej. Wilmer" /></div>' +
          '<div class="field"><label>Correo</label><input name="email" type="email" placeholder="wilmer@moventiglobal.com" required /></div>' +
          '<button class="btn btn-primary" type="submit" style="align-self:flex-start">Añadir</button>' +
        '</form>' +
        '<hr style="border:none;border-top:1px solid var(--border);margin:1.1rem 0" />' +
        '<div class="card-title" style="font-size:.92rem">Verificar</div>' +
        '<p style="color:var(--ink-muted);font-size:.84rem;margin-bottom:.7rem">Manda un correo de prueba a los destinatarios de arriba para confirmar que llegan los avisos.</p>' +
        '<button class="btn btn-subtle btn-sm" onclick="App.sendTestNotify()" '+(notifyTestBusy?'disabled':'')+'>'+(notifyTestBusy?'Enviando…':'Enviar prueba')+'</button>' +
      '</div>' +
      '<div class="card">' +
        (list.length===0 ? '<div class="table-empty">No hay destinatarios configurados. Mientras tanto se usa un correo predeterminado del sistema.</div>' :
        '<div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Correo</th><th>Acciones</th></tr></thead><tbody>'+rows+'</tbody></table></div>') +
      '</div>' +
    '</div>';
  }

  // Últimos 12 meses + el mes en curso (para el estimado a una fecha).
  function opcionesMesCierre(){
    var nombres = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    var hoy = new Date(), out = '';
    for(var i=0;i<=12;i++){
      var d = new Date(hoy.getFullYear(), hoy.getMonth()-i, 1), ym = ymDe(d);
      var label = nombres[d.getMonth()]+' '+d.getFullYear() + (i===0 ? ' (en curso)' : '');
      out += '<option value="'+ym+'" '+(ym===reportMonth?'selected':'')+'>'+label+'</option>';
    }
    return out;
  }
  function renderAdminReporte(){
    var clients = STATE.users.filter(function(u){ return u.role==='client'; });
    var list = STATE.requests.filter(function(r){
      if(reportFilter.cliente!=='todos' && r.clientUsername!==reportFilter.cliente) return false;
      if(reportFilter.estado!=='todos' && r.status!==reportFilter.estado) return false;
      if(reportFilter.tipo!=='todos' && r.licenseTypeId!==reportFilter.tipo) return false;
      if(reportFilter.proyecto!=='todos' && r.project!==reportFilter.proyecto) return false;
      return true;
    }).sort(function(a,b){ return a.requestedAt<b.requestedAt?-1:1; });

    var totalSolicitudes = list.length;
    var aprobadas = list.filter(esAprobada);
    var montoAprobado = aprobadas.reduce(function(s,r){ return s + montoTotal(r); }, 0);
    var totalLicencias = list.reduce(function(s,r){ return s + Number(r.quantity||1); }, 0);

    // Desglose por proyecto/servicio (Ligo-Prod / LigoCloudPlatform /
    // Ligo-Dev): a qué proyecto quedaron vinculadas las cuentas solicitadas
    // en el periodo/filtros actuales.
    var projectBreakdown = projectNames(false).map(function(p){
      var reqsP = list.filter(function(r){ return r.project===p; });
      var aprobadasP = reqsP.filter(esAprobada);
      return {
        project: p,
        count: reqsP.length,
        aprobadas: aprobadasP.length,
        monto: aprobadasP.reduce(function(s,r){ return s + montoTotal(r); }, 0)
      };
    });
    var sinProyectoCount = list.filter(function(r){ return !r.project; }).length;

    var allTypesReporte = STATE.licenseTypes;
    var rows = list.map(function(r){
      if(editingRequestId===r.id){
        var typeOptionsR = allTypesReporte.map(function(t){ return '<option value="'+t.id+'" '+(t.id===r.licenseTypeId?'selected':'')+'>'+esc(t.name)+'</option>'; }).join('');
        var projectOptionsR = projectOptionsHtml(projectNames(false, r.project), r.project);
        return '<tr class="editing-row">' +
          '<td class="num"><input class="mini-input" id="edit-reqdate-'+r.id+'" type="date" value="'+(dateOnly(r.requestedAt)||'')+'" /></td>' +
          '<td class="wrap">'+clipCell(r.clientName)+'</td>' +
          '<td class="wrap"><select class="mini-select" id="edit-type-'+r.id+'">'+typeOptionsR+'</select></td>' +
          '<td class="wrap"><select class="mini-select" id="edit-project-'+r.id+'">'+projectOptionsR+'</select></td>' +
          '<td class="num"><div class="num-field"><input class="mini-input" id="edit-qty-'+r.id+'" type="number" min="1" step="1" value="'+(r.quantity||1)+'" />'+numStepper('edit-qty-'+r.id,1)+'</div></td>' +
          '<td class="num"><input class="mini-input" id="edit-date-'+r.id+'" type="date" value="'+(r.neededFrom||'')+'" /></td>' +
          '<td><span class="pill '+statusCls(r.status)+'">'+r.status+'</span></td>' +
          '<td class="num">'+precioUnitCell(r)+'</td>' +
          '<td class="num">'+money(montoTotal(r))+'</td>' +
          '<td class="num"><input class="mini-input" id="edit-actdate-'+r.id+'" type="date" value="'+(dateOnly(r.activatedAt)||'')+'" /></td>' +
          '<td class="num">'+vencimientoCell(r)+'</td>' +
          '<td><button class="btn btn-success btn-sm" onclick="App.saveEditRequest(\''+r.id+'\')">Guardar</button> <button class="btn btn-subtle btn-sm" onclick="App.cancelEditRequest()">Cancelar</button></td>' +
        '</tr>';
      }
      return '<tr>' +
        '<td class="num">'+fmtDateShort(r.requestedAt)+'</td>' +
        '<td class="wrap">'+clipCell(r.clientName)+'</td>' +
        '<td class="wrap">'+clipCell(r.licenseTypeName)+'</td>' +
        '<td class="wrap">'+clipCell(r.project||'—')+'</td>' +
        '<td class="num">'+(r.quantity||1)+'</td>' +
        '<td class="num">'+fmtDateShort(r.neededFrom)+'</td>' +
        '<td><span class="pill '+statusCls(r.status)+'">'+r.status+'</span></td>' +
        '<td class="num">'+precioUnitCell(r)+'</td>' +
        '<td class="num">'+money(montoTotal(r))+'</td>' +
        '<td class="num">'+activadaCell(r)+'</td>' +
        '<td class="num">'+vencimientoCell(r)+'</td>' +
        '<td>'+buildRowMenu(r.id, [
          {label:'Editar', onclick:"App.startEditRequest('"+r.id+"')"},
          {label:'Eliminar', cls:'rm-danger', onclick:"App.removeRequest('"+r.id+"')"}
        ])+'</td>' +
      '</tr>';
    }).join('');

    return '<div class="section-head"><h2>Reporte</h2><p>Consulta todas las licencias vigentes desde su activación, con su precio unitario y su monto.</p></div>' +
    '<div class="toolbar">' +
      '<div class="field" style="max-width:250px"><label>Mes de cierre</label><select onchange="App.setReportMonth(this.value)">' +
        opcionesMesCierre() +
      '</select>' +
      '<p class="hint">Mes cerrado: prorratea las licencias activadas ese mes. En curso: estimado a la fecha de hoy.</p></div>' +
      '<div class="field"><label>Cliente</label><select onchange="App.setReportFilter(\'cliente\', this.value)">' +
        '<option value="todos">Todos</option>' + clients.map(function(c){ return '<option value="'+c.username+'" '+(reportFilter.cliente===c.username?'selected':'')+'>'+esc(c.name)+'</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label>Estado</label><select onchange="App.setReportFilter(\'estado\', this.value)">' +
        ['todos'].concat(ESTADOS).map(function(s){ return '<option value="'+s+'" '+(reportFilter.estado===s?'selected':'')+'>'+(s==='todos'?'Todos':s)+'</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label>Tipo de licencia</label><select onchange="App.setReportFilter(\'tipo\', this.value)">' +
        '<option value="todos">Todos</option>' + STATE.licenseTypes.map(function(t){ return '<option value="'+t.id+'" '+(reportFilter.tipo===t.id?'selected':'')+'>'+esc(t.name)+'</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label>Proyecto</label><select onchange="App.setReportFilter(\'proyecto\', this.value)">' +
        '<option value="todos">Todos</option>' + projectOptionsHtml(projectNames(false), reportFilter.proyecto) +
      '</select></div>' +
      '<button class="btn btn-primary" style="margin-left:auto" onclick="App.exportReport()">Descargar reporte (Excel)</button>' +
    '</div>' +
    '<div class="stat-row" style="margin-bottom:1.2rem">' +
      '<div class="stat-tile"><div class="label">Solicitudes</div><div class="value">'+totalSolicitudes+'</div></div>' +
      '<div class="stat-tile"><div class="label">Aprobadas</div><div class="value teal">'+aprobadas.length+'</div></div>' +
      '<div class="stat-tile"><div class="label">Monto aprobado</div><div class="value accent">'+money(montoAprobado)+'</div></div>' +
      '<div class="stat-tile"><div class="label">Licencias solicitadas</div><div class="value">'+totalLicencias+'</div></div>' +
    '</div>' +
    '<div class="card" style="margin-bottom:1.2rem">' +
      '<div class="card-title" style="padding:.9rem 1rem 0">Desglose por proyecto</div>' +
      '<div class="table-wrap"><table class="table-dense"><thead><tr><th>Proyecto</th><th>Solicitudes</th><th>Aprobadas</th><th>Monto aprobado</th></tr></thead><tbody>' +
        projectBreakdown.map(function(pb){
          return '<tr>' +
            '<td class="wrap">'+clipCell(pb.project)+'</td>' +
            '<td class="num">'+pb.count+'</td>' +
            '<td class="num">'+pb.aprobadas+'</td>' +
            '<td class="num">'+money(pb.monto)+'</td>' +
          '</tr>';
        }).join('') +
        (sinProyectoCount>0 ? '<tr><td class="wrap" style="color:var(--ink-subtle)">Sin proyecto (solicitudes previas a este cambio)</td><td class="num">'+sinProyectoCount+'</td><td class="num">—</td><td class="num">—</td></tr>' : '') +
      '</tbody></table></div>' +
    '</div>' +
    '<div class="card">' +
      (list.length===0 ? '<div class="table-empty">No hay solicitudes con estos filtros.</div>' :
      '<div class="table-wrap"><table class="table-dense"><thead><tr><th title="Fecha de solicitud">Solicitud</th><th>Cliente</th><th>Tipo</th><th>Proyecto</th><th>Cantidad</th><th title="Fecha requerida">Requerida</th><th>Estado</th><th title="Ya prorrateado desde la fecha de activación cuando aplica">Precio unitario</th><th>Monto total</th><th title="Fecha de activación">Activación</th><th title="Las licencias son anuales: vence 1 año después de la activación">Vencimiento</th><th>Acción</th></tr></thead><tbody>'+rows+'</tbody></table></div>') +
    '</div>';
  }

  function renderAdminCuenta(user){
    var errMsg = {
      invalid_input: 'Completa todos los campos. La nueva contraseña debe tener al menos 8 caracteres y coincidir en ambos campos.',
      invalid_current_password: 'La contraseña actual no es correcta.',
      server_error: 'Ocurrió un error al guardar. Intenta nuevamente.'
    };
    return '<div class="card" style="max-width:480px">' +
      '<h3 style="margin-top:0">Cambiar mi contraseña</h3>' +
      '<p style="color:var(--ink-subtle)">Cambia la contraseña de la cuenta de administrador ('+esc(user.username)+') sin salir del panel ni depender del correo de recuperación.</p>' +
      (adminAccountState.done ?
        '<div class="notice-box">' + noticeIconSvg() + '<span>Contraseña actualizada correctamente.</span></div>' +
        '<div style="margin-top:.75rem"><button type="button" class="btn btn-ghost btn-sm" onclick="App.resetChangeAdminPasswordForm()">Cambiarla de nuevo</button></div>' :
        '<form onsubmit="App.submitChangeAdminPassword(event)">' +
          '<div class="field"><label>Nueva contraseña</label><input type="password" name="newPassword" autocomplete="new-password" minlength="8" required /></div>' +
          '<div class="field"><label>Confirmar nueva contraseña</label><input type="password" name="confirmPassword" autocomplete="new-password" minlength="8" required /></div>' +
          (adminAccountState.error ? '<div class="login-error">'+esc(errMsg[adminAccountState.error]||'Ocurrió un error.')+'</div>' : '') +
          '<button type="submit" class="btn btn-primary" '+(adminAccountState.busy?'disabled':'')+' style="margin-top:.5rem">'+(adminAccountState.busy?'Guardando…':'Guardar nueva contraseña')+'</button>' +
        '</form>'
      ) +
    '</div>';
  }

  function renderAdmin(user){
    var body;
    if(adminTab==='solicitudes') body = renderAdminSolicitudes();
    else if(adminTab==='tipos') body = renderAdminTipos();
    else if(adminTab==='proyectos') body = renderAdminProyectos();
    else if(adminTab==='clientes') body = renderAdminClientes();
    else if(adminTab==='notificaciones') body = renderAdminNotificaciones();
    else if(adminTab==='cuenta') body = renderAdminCuenta(user);
    else body = renderAdminReporte();

    return topbar(user, 'Administrador') +
    '<div class="app-body">' + adminNav() + '<div class="main-area">' + body + '</div></div>';
  }

  /* ================= main render ================= */
  // Confirmación en la propia página (no confirm() del navegador) para las
  // acciones que no se pueden deshacer, como enviar el correo de solicitud.
  function renderConfirmDialog(){
    if(!confirmDialog) return '';
    return '<div class="modal-overlay" onclick="App.cancelConfirm()"></div>' +
      '<div class="modal-card" role="dialog" aria-modal="true">' +
        '<div class="modal-title">'+esc(confirmDialog.titulo)+'</div>' +
        '<p class="modal-text">'+esc(confirmDialog.mensaje)+'</p>' +
        (confirmDialog.detalle ? '<div class="modal-detail">'+confirmDialog.detalle+'</div>' : '') +
        '<div class="modal-actions">' +
          '<button class="btn btn-ghost" type="button" onclick="App.cancelConfirm()">Cancelar</button>' +
          '<button class="btn btn-primary" type="button" onclick="App.acceptConfirm()">'+esc(confirmDialog.etiquetaOk||'Confirmar')+'</button>' +
        '</div>' +
      '</div>';
  }

  function askConfirm(opts){
    confirmDialog = opts;
    render();
  }

  function render(){
    var html;
    if(resetTokenFromUrl){
      html = renderResetPasswordScreen();
    } else {
      var user = currentUser();
      if(!user) html = renderLogin();
      else if(user.role==='admin'){
        // Botón "Revisar y aprobar solicitud" del correo de aviso: la
        // primera vez que renderizamos ya logueados como admin con
        // ?verSolicitud=<id> en la URL, saltamos a la pestaña Solicitudes
        // sin filtros (para no ocultar la fila) y limpiamos la URL. La
        // fila se sigue resaltando (ver renderAdminSolicitudes) mientras
        // highlightRequestId no cambie.
        if(highlightRequestId && !highlightJumpDone){
          highlightJumpDone = true;
          adminTab = 'solicitudes';
          solFilter = { cliente:'todos', estado:'todos', proyecto:'todos' };
          try{
            var url = new URL(window.location.href);
            url.searchParams.delete('verSolicitud');
            window.history.replaceState({}, '', url.toString());
          }catch(e){}
        }
        html = renderAdmin(user);
      }
      else html = renderClient(user);
    }
    document.getElementById('root').innerHTML = html + renderConfirmDialog();
    if(highlightRequestId){
      var rowEl = document.getElementById('req-row-'+highlightRequestId);
      if(rowEl && rowEl.scrollIntoView) rowEl.scrollIntoView({behavior:'smooth', block:'center'});
    }
  }

  /* ================= actions (exposed) ================= */
  var App = {
    setLoginRole: function(r){ loginRole = r; loginError=''; render(); },
    stepNumber: function(id, dir, min){
      var el = document.getElementById(id);
      if(!el) return;
      var step = parseFloat(el.step) || 1;
      var val = parseFloat(el.value);
      if(isNaN(val)) val = (min!=null ? min : 0);
      var next = val + dir*step;
      if(min!=null && next<min) next = min;
      var decimals = (String(step).split('.')[1]||'').length;
      next = Number(next.toFixed(decimals));
      el.value = next;
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
    },
    toggleTheme: function(){ currentTheme = currentTheme==='dark' ? 'light' : 'dark'; applyTheme(); render(); },
    // Mostrar/ocultar contraseña sin re-render (no perder lo escrito ni el foco).
    toggleLoginPassword: function(btn){
      var input = document.getElementById('login-password');
      if(!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', show ? 'Ocultar la contraseña' : 'Mostrar la contraseña en pantalla');
      btn.innerHTML = eyeIcon(show);
      input.focus();
    },
    submitLogin: async function(ev){
      ev.preventDefault();
      var f = ev.target;
      await tryLogin(f.username.value.trim(), f.password.value);
    },
    logout: logout,
    startForgotPassword: function(ev){
      if(ev) ev.preventDefault();
      forgotPasswordOpen = true;
      forgotPasswordSent = false;
      forgotPasswordBusy = false;
      render();
    },
    cancelForgotPassword: function(ev){
      if(ev) ev.preventDefault();
      forgotPasswordOpen = false;
      forgotPasswordSent = false;
      forgotPasswordBusy = false;
      render();
    },
    submitForgotPassword: async function(ev){
      ev.preventDefault();
      var f = ev.target;
      var username = f.username.value.trim();
      forgotPasswordBusy = true;
      render();
      try{
        await fetch('/api/request-password-reset', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, PORTAL_API_TOKEN ? { 'x-portal-token': PORTAL_API_TOKEN } : {}),
          body: JSON.stringify({ username: username })
        });
      }catch(e){ /* si no hay backend, no podemos hacer nada más aquí */ }
      forgotPasswordBusy = false;
      forgotPasswordSent = true;
      render();
    },
    goToLoginAfterReset: function(){
      try{
        var url = new URL(window.location.href);
        url.searchParams.delete('resetToken');
        window.history.replaceState({}, '', url.toString());
      }catch(e){}
      resetTokenFromUrl = null;
      resetPasswordState = { busy:false, done:false, error:'' };
      render();
    },
    submitResetPassword: async function(ev){
      ev.preventDefault();
      var f = ev.target;
      var newPassword = f.newPassword.value;
      var confirmPassword = f.confirmPassword.value;
      if(!newPassword || newPassword.length<8 || newPassword!==confirmPassword){
        resetPasswordState = { busy:false, done:false, error:'invalid_input' };
        render();
        return;
      }
      resetPasswordState = { busy:true, done:false, error:'' };
      render();
      try{
        var resp = await fetch('/api/reset-password', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, PORTAL_API_TOKEN ? { 'x-portal-token': PORTAL_API_TOKEN } : {}),
          body: JSON.stringify({ token: resetTokenFromUrl, newPassword: newPassword })
        });
        var data = await resp.json().catch(function(){ return {}; });
        if(resp.ok && data.ok){
          resetPasswordState = { busy:false, done:true, error:'' };
        } else {
          resetPasswordState = { busy:false, done:false, error: data.error || 'server_error' };
        }
      }catch(e){
        resetPasswordState = { busy:false, done:false, error:'server_error' };
      }
      render();
    },
    setAdminTab: function(t){ adminTab = t; saveUiState(); render(); },

    resetChangeAdminPasswordForm: function(){
      adminAccountState = { busy:false, done:false, error:'' };
      render();
    },
    submitChangeAdminPassword: async function(ev){
      ev.preventDefault();
      var f = ev.target;
      var user = currentUser();
      var newPassword = f.newPassword.value;
      var confirmPassword = f.confirmPassword.value;
      if(!user || !newPassword || newPassword.length<8 || newPassword!==confirmPassword){
        adminAccountState = { busy:false, done:false, error:'invalid_input' };
        render();
        return;
      }
      adminAccountState = { busy:true, done:false, error:'' };
      render();
      try{
        var resp = await fetch('/api/change-admin-password', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, PORTAL_API_TOKEN ? { 'x-portal-token': PORTAL_API_TOKEN } : {}),
          body: JSON.stringify({ username: user.username, newPassword: newPassword })
        });
        var data = await resp.json().catch(function(){ return {}; });
        if(resp.ok && data.ok){
          adminAccountState = { busy:false, done:true, error:'' };
        } else {
          adminAccountState = { busy:false, done:false, error: data.error || 'server_error' };
        }
      }catch(e){
        adminAccountState = { busy:false, done:false, error:'server_error' };
      }
      render();
    },

    submitRequest: function(ev){
      ev.preventDefault();
      var user = currentUser();
      var f = ev.target;
      var typeId = f.licenseTypeId.value;
      var type = STATE.licenseTypes.find(function(t){ return t.id===typeId; });
      var qty = Math.max(1, parseInt(f.quantity.value, 10) || 1);
      var newReq = {
        id: uid('r'),
        clientUsername: user.username,
        clientName: user.name,
        licenseTypeId: typeId,
        licenseTypeName: type ? type.name : '—',
        project: f.project.value,
        price: type ? type.price : 0,
        quantity: qty,
        neededFrom: f.neededFrom.value,
        note: f.note.value.trim(),
        requestedAt: new Date().toISOString(),
        status: 'pendiente', reviewedBy: null, reviewedAt: null,
        notifiedToIngram: false, notifiedAt: null, notifiedBy: null
      };
      commit(function(s){ s.requests.push(newReq); });
      showToast('Solicitud enviada.', 'success');
      notifyNewRequest(newReq);
    },

    reviewRequest: function(id, status){
      var user = currentUser();
      commit(function(s){
        var r = s.requests.find(function(x){ return x.id===id; });
        if(!r) return;
        r.status = status; r.reviewedBy = user.name; r.reviewedAt = new Date().toISOString();
      });
    },
    setSolFilter: function(k,v){ solFilter[k]=v; saveUiState(); render(); },

    startEditRequest: function(id){ editingRequestId = id; render(); },
    cancelEditRequest: function(){ editingRequestId = null; render(); },
    saveEditRequest: function(id){
      var typeEl = document.getElementById('edit-type-'+id);
      var qtyEl = document.getElementById('edit-qty-'+id);
      var dateEl = document.getElementById('edit-date-'+id);
      var reqDateEl = document.getElementById('edit-reqdate-'+id);
      var actDateEl = document.getElementById('edit-actdate-'+id);
      var projectEl = document.getElementById('edit-project-'+id); // solo existe en la tabla de Solicitudes
      var qty = Math.max(1, parseInt(qtyEl.value, 10) || 1);
      var neededFrom = dateEl.value;
      if(!neededFrom){ showToast('Indica la fecha en que se necesita la licencia.', 'error'); return; }
      var requestedDate = reqDateEl ? reqDateEl.value : '';
      if(!requestedDate){ showToast('Indica la fecha de solicitud.', 'error'); return; }
      var activatedDate = actDateEl ? actDateEl.value : '';
      var typeId = typeEl.value;
      var type = STATE.licenseTypes.find(function(t){ return t.id===typeId; });
      editingRequestId = null;
      commit(function(s){
        var r = s.requests.find(function(x){ return x.id===id; });
        if(!r) return;
        r.quantity = qty;
        r.neededFrom = neededFrom;
        r.requestedAt = requestedDate;
        r.activatedAt = activatedDate || null;
        if(type){ r.licenseTypeId = type.id; r.licenseTypeName = type.name; r.price = type.price; }
        if(projectEl) r.project = projectEl.value;
      });
      showToast('Solicitud actualizada.', 'success');
    },
    removeRequest: function(id){
      if(!confirm('¿Eliminar esta solicitud? Esta acción no se puede deshacer.')) return;
      commit(function(s){ s.requests = s.requests.filter(function(x){ return x.id!==id; }); });
      selectedForIngram.delete(id);
      showToast('Solicitud eliminada.', 'success');
    },

    // ---------- Carga de histórico ----------
    toggleImportHist: function(){
      importHistOpen = !importHistOpen;
      if(!importHistOpen){ importHistRows = null; importHistErrors = []; importHistFileName = ''; manualHistOpen = false; }
      render();
    },
    downloadHistTemplate: function(){
      var ejemplo = ['TARJETAS PERUANAS','Google Workspace Business Plus','tarjetasperuanas.com.pe','200','22.00','01/08/2026','05/08/2026','05/08/2026','activado','Stefano Borckardt'];
      downloadCsv('plantilla_historico_licencias.csv', HIST_CSV_HEADER.join(';')+'\n'+ejemplo.join(';'));
    },
    handleImportHistFile: function(input){
      var file = input.files && input.files[0];
      importHistRows = null; importHistErrors = [];
      if(!file){ render(); return; }
      importHistFileName = file.name;
      var reader = new FileReader();
      reader.onload = function(){
        var parsed = parseHistCsv(String(reader.result||''));
        importHistRows = parsed.rows;
        importHistErrors = parsed.errors;
        if(!parsed.rows.length && !parsed.errors.length){ importHistErrors = ['No se encontraron filas de datos en el archivo.']; }
        render();
      };
      reader.onerror = function(){ importHistErrors = ['No se pudo leer el archivo.']; render(); };
      reader.readAsText(file, 'utf-8');
      render();
    },
    cancelImportHist: function(){
      importHistRows = null; importHistErrors = []; importHistFileName = '';
      var input = document.getElementById('hist-csv-input');
      if(input) input.value = '';
      render();
    },
    confirmImportHist: async function(){
      if(!importHistRows || !importHistRows.length) return;
      importHistBusy = true; render();
      var rowsToImport = importHistRows.slice();
      var ok = await commitSynced(function(s){
        rowsToImport.forEach(function(row){ s.requests.push(buildHistRequest(s, row)); });
      });
      importHistBusy = false;
      importHistRows = null; importHistErrors = []; importHistFileName = '';
      var input = document.getElementById('hist-csv-input');
      if(input) input.value = '';
      showToast(ok ? rowsToImport.length+' solicitud'+(rowsToImport.length===1?'':'es')+' histórica'+(rowsToImport.length===1?'':'s')+' importada'+(rowsToImport.length===1?'':'s')+'.' : 'Se importó localmente, pero no se pudo sincronizar. Reintenta.', ok ? 'success' : 'error');
    },
    toggleManualHist: function(){ manualHistOpen = !manualHistOpen; render(); },
    submitManualHist: async function(ev){
      ev.preventDefault();
      var f = ev.target;
      var row = {
        cliente: f.cliente.value.trim(),
        tipo: f.tipo.value.trim(),
        proyecto: f.proyecto.value.trim(),
        cantidad: Math.max(1, parseInt(f.cantidad.value,10)||1),
        precio: Number(f.precio.value)||0,
        fSol: f.fSol.value,
        fReq: f.fReq.value,
        fAct: f.fAct.value||'',
        estado: f.estado.value,
        gestor: f.gestor.value.trim()
      };
      if(!row.cliente || !row.tipo || !row.fSol || !row.fReq){ showToast('Completa cliente, tipo y las fechas de solicitud/requerida.', 'error'); return; }
      if(row.estado==='activado' && !row.fAct){ showToast('El estado "activado" necesita la fecha de activación.', 'error'); return; }
      var ok = await commitSynced(function(s){ s.requests.push(buildHistRequest(s, row)); });
      showToast(ok ? 'Solicitud histórica agregada.' : 'Se agregó localmente, pero no se pudo sincronizar. Reintenta.', ok ? 'success' : 'error');
      if(ok){ f.reset(); }
    },
    toggleRowMenu: function(id, evt){
      if(openRowMenu===id){
        openRowMenu = null; rowMenuPos = null;
      } else {
        var rect = evt.currentTarget.getBoundingClientRect();
        var menuHeightEstimate = 170; // suficiente para hasta ~4 opciones
        var openUp = (window.innerHeight - rect.bottom) < menuHeightEstimate && rect.top > menuHeightEstimate;
        openRowMenu = id;
        rowMenuPos = {
          left: Math.max(8, rect.right - 160),
          dir: openUp ? 'up' : 'down',
          y: openUp ? (window.innerHeight - rect.top + 6) : (rect.bottom + 6)
        };
      }
      render();
    },
    closeRowMenu: function(){ openRowMenu = null; rowMenuPos = null; render(); },

    setClientProject: function(v){ clientFilterProject = v; render(); },
    cancelConfirm: function(){
      confirmDialog = null;
      render();
    },
    acceptConfirm: function(){
      var accion = confirmDialog && confirmDialog.onOk;
      confirmDialog = null;
      render();
      if(accion) accion();
    },
    sendTestNotify: async function(){
      var recipients = (STATE.settings.notifyEmails||[])
        .map(function(n){ return (n.email||'').trim(); })
        .filter(function(e){ return e && e.indexOf('@')>-1; });
      if(!recipients.length) recipients = NEW_REQUEST_NOTIFY_EMAILS;
      notifyTestBusy = true; render();
      var ok = await sendEmailBestEffort(
        recipients,
        'Prueba de aviso — Portal de licencias Moventi',
        'Este es un correo de prueba del portal de licencias. Si lo recibes, los avisos de nueva solicitud llegarán a esta dirección.',
        '<div style="font-family:Arial,sans-serif;font-size:14px"><p>Este es un correo de prueba del portal de licencias.</p>' +
        '<p>Si lo recibes, los avisos de nueva solicitud llegarán a esta dirección con su botón para revisar y aprobar.</p>' +
        '<p style="margin-top:18px"><a href="' + window.location.origin + '/admin" target="_blank" rel="noopener" style="display:inline-block;background:#4f46e5;color:#ffffff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">Abrir el panel</a></p></div>'
      );
      notifyTestBusy = false; render();
      showToast(ok
        ? 'Correo de prueba enviado a: ' + recipients.join(', ')
        : 'No se pudo enviar la prueba (' + (lastEmailError||'sin backend') + ').', ok ? 'success' : 'error');
    },
    addNotifyEmail: async function(ev){
      ev.preventDefault();
      var f = ev.target;
      var name = f.name.value.trim();
      var email = f.email.value.trim();
      if(!email || email.indexOf('@')===-1){ showToast('Ingresa un correo válido.', 'error'); return; }
      f.reset();
      var synced = await commitSynced(function(s){
        if(!s.settings.notifyEmails) s.settings.notifyEmails = [];
        s.settings.notifyEmails.push({ id: uid('ne'), name: name, email: email });
      });
      showToast(synced
        ? 'Destinatario añadido. Ya recibirá los avisos.'
        : 'No se pudo guardar el destinatario en el servidor; no recibirá avisos todavía. Reintenta.', synced ? 'success' : 'error');
    },
    removeNotifyEmail: async function(id){
      var synced = await commitSynced(function(s){ s.settings.notifyEmails = (s.settings.notifyEmails||[]).filter(function(x){ return x.id!==id; }); });
      showToast(synced ? 'Destinatario eliminado.' : 'No se pudo sincronizar la eliminación. Reintenta.', synced ? 'success' : 'error');
    },
    setIngramEmail: function(val){
      commit(function(s){ s.settings.ingramEmail = val.trim(); });
      showToast('Correo de contacto actualizado.', 'success');
    },
    setIngramCc: function(val){
      commit(function(s){ s.settings.ingramCc = val.trim(); });
      showToast('Copia (CC) actualizada.', 'success');
    },
    toggleEmailTplEditor: function(){ emailTplOpen = !emailTplOpen; render(); },
    setEmailSubject: function(val){
      commit(function(s){ s.settings.emailSubjectTemplate = val; });
      showToast('Asunto del correo actualizado.', 'success');
    },
    setEmailBody: function(val){
      commit(function(s){ s.settings.emailBodyTemplate = val; });
      showToast('Mensaje del correo actualizado.', 'success');
    },
    resetEmailTemplate: function(){
      commit(function(s){ s.settings.emailSubjectTemplate = DEFAULT_EMAIL_SUBJECT; s.settings.emailBodyTemplate = DEFAULT_EMAIL_BODY; });
      showToast('Mensaje restaurado al predeterminado.', 'success');
    },
    toggleIngramSelect: function(id, checked){
      if(checked) selectedForIngram.add(id); else selectedForIngram.delete(id);
      render();
    },
    selectAllPendingIngram: function(){
      STATE.requests.forEach(function(r){ if(puedeEnviarse(r)) selectedForIngram.add(r.id); });
      render();
    },
    // Paso final: el operador confirma que el distribuidor activó la
    // licencia. Cambia el estado a "activado" y avisa por correo al cliente.
    markActivated: function(id){
      var r = STATE.requests.find(function(x){ return x.id===id; });
      if(!r) return;
      var cli = STATE.users.find(function(u){ return u.username===r.clientUsername; });
      var correoCliente = cli && (cli.email||'').trim();
      askConfirm({
        titulo: '¿Confirmas que la licencia ya está activa?',
        mensaje: correoCliente
          ? 'La solicitud pasa a "activado" y se avisa por correo a ' + correoCliente + '.'
          : 'La solicitud pasa a "activado". Este cliente no tiene correo de aviso cargado (pestaña Clientes), así que solo se notifica internamente.',
        detalle: '<div><strong>' + esc(r.licenseTypeName) + '</strong> — ' + (r.quantity||1) + ' · ' + esc(r.clientName) + '</div>',
        etiquetaOk: 'Sí, está activa',
        onOk: async function(){
          var admin = currentUser();
          var hoy = todayYmd();
          var ok = await commitSynced(function(st){
            var t = st.requests.find(function(x){ return x.id===id; });
            if(!t) return;
            t.status = 'activado';
            t.activatedAt = hoy;
            t.activatedBy = admin ? admin.name : null;
          });
          render();
          await notifyActivation(STATE.requests.find(function(x){ return x.id===id; }));
          showToast(ok ? 'Licencia marcada como activada y aviso enviado.' : 'Se marcó localmente, pero no se pudo sincronizar. Reintenta.', ok ? 'success' : 'error');
        }
      });
    },
    // Pide confirmación antes de enviar (evita clics accidentales); el envío
    // real vive en doSendToIngram.
    sendToIngram: function(){
      var ingramEmail = (STATE.settings.ingramEmail||'').trim();
      if(!ingramEmail){ showToast('Configura primero el correo de contacto para el envío.', 'error'); return; }
      var ids = Array.from(selectedForIngram);
      var items = STATE.requests.filter(function(r){ return ids.indexOf(r.id)>-1 && puedeEnviarse(r); });
      if(items.length===0){ showToast('Selecciona al menos una solicitud sin enviar.', 'error'); return; }
      var ccList = parseEmailList(STATE.settings.ingramCc);
      askConfirm({
        titulo: '¿Seguro que deseas enviar por correo la solicitud de creación?',
        mensaje: items.length===1
          ? 'Se enviará 1 solicitud aprobada y quedará marcada como enviada.'
          : 'Se enviarán ' + items.length + ' solicitudes aprobadas y quedarán marcadas como enviadas.',
        detalle: '<div><strong>Para:</strong> ' + esc(ingramEmail) + '</div>' +
          (ccList.length ? '<div><strong>Copia:</strong> ' + esc(ccList.join(', ')) + '</div>' : '') +
          '<ul style="margin:.5rem 0 0;padding-left:1.1rem">' +
          items.map(function(r){
            return '<li>' + esc(r.licenseTypeName) + ' — ' + (r.quantity||1) + ' · ' + esc(r.clientName) +
              ' · habilitar desde el <strong>' + fmtDateShort(r.neededFrom) + '</strong></li>';
          }).join('') + '</ul>',
        etiquetaOk: 'Sí, enviar',
        onOk: App.doSendToIngram
      });
    },
    doSendToIngram: async function(){
      var ingramEmail = (STATE.settings.ingramEmail||'').trim();
      var ccList = parseEmailList(STATE.settings.ingramCc);
      var ids = Array.from(selectedForIngram);
      var items = STATE.requests.filter(function(r){ return ids.indexOf(r.id)>-1 && puedeEnviarse(r); });
      if(items.length===0){ showToast('Selecciona al menos una solicitud sin enviar.', 'error'); return; }

      var admin = currentUser();
      var detalle = items.map(function(r){
        return '- ' + r.licenseTypeName + ' | Proyecto: ' + (r.project||'—') + ' | Cantidad: ' + (r.quantity||1) + ' | Cliente: ' + r.clientName + ' | Habilitar desde: ' + fmtDateShort(r.neededFrom);
      }).join('\n');
      var htmlRows = items.map(function(r){
        return '<tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">'+esc(r.licenseTypeName)+'</td>' +
          '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">'+esc(r.project||'—')+'</td>' +
          '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center">'+(r.quantity||1)+'</td>' +
          '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">'+esc(r.clientName)+'</td>' +
          '<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb"><strong>'+fmtDateShort(r.neededFrom)+'</strong></td></tr>';
      }).join('');
      var detalleHtml = '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;margin:.4em 0">' +
        '<tr style="background:#f3f4f6"><th style="padding:6px 10px;text-align:left">Tipo</th><th style="padding:6px 10px;text-align:left">Proyecto</th><th style="padding:6px 10px;text-align:center">Cantidad</th><th style="padding:6px 10px;text-align:left">Cliente</th><th style="padding:6px 10px;text-align:left">Habilitar desde</th></tr>' +
        htmlRows + '</table>';
      var tplVars = {
        cantidad: items.length,
        unidad: items.length===1 ? 'solicitud' : 'solicitudes',
        detalle: detalle,
        admin: admin ? admin.name : 'Moventi',
        fecha: fmtDate(new Date().toISOString())
      };
      var subject = renderTemplate(STATE.settings.emailSubjectTemplate || DEFAULT_EMAIL_SUBJECT, tplVars);
      var body = renderTemplate(STATE.settings.emailBodyTemplate || DEFAULT_EMAIL_BODY, tplVars);
      var htmlBody = '<div style="font-family:Arial,sans-serif;font-size:14px">' +
        renderTemplateHtml(STATE.settings.emailBodyTemplate || DEFAULT_EMAIL_BODY, tplVars, {detalle: detalleHtml}) +
        '</div>';

      if(!mcpCap){
        // Outside the Claude artifact runtime there's no connected Gmail via
        // Claude — but if this build is hosted with the /api/send-email
        // backend (see portal-licencias-vercel/api/send-email.js), try that
        // first for true automatic sending before falling back to mailto.
        try{
          var apiResp = await fetch('/api/send-email', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, PORTAL_API_TOKEN ? { 'x-portal-token': PORTAL_API_TOKEN } : {}),
            body: JSON.stringify({ to: ingramEmail, cc: ccList, subject: subject, text: body, html: htmlBody })
          });
          if(apiResp.ok){
            commit(function(s){
              s.requests.forEach(function(r){
                if(ids.indexOf(r.id)>-1 && puedeEnviarse(r)){
                  r.notifiedToIngram = true; r.notifiedAt = new Date().toISOString(); r.notifiedBy = admin ? admin.name : null; r.status = 'en proceso';
                }
              });
            });
            selectedForIngram.clear();
            render();
            showToast('Correo enviado (' + items.length + ' solicitud' + (items.length===1?'':'es') + ').', 'success');
            return;
          }
          console.warn('send-email API respondió con error, usando mailto como respaldo', await apiResp.text().catch(function(){return '';}));
        }catch(e){
          // No backend disponible en este hosting (p.ej. dentro del artifact de Claude) — seguimos con mailto.
        }

        // Fallback: abrir el cliente de correo del administrador con el mensaje prefijado.
        var mailto = 'mailto:' + encodeURIComponent(ingramEmail) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body) +
          (ccList.length ? '&cc=' + encodeURIComponent(ccList.join(',')) : '');
        window.location.href = mailto;
        commit(function(s){
          s.requests.forEach(function(r){
            if(ids.indexOf(r.id)>-1 && puedeEnviarse(r)){
              r.notifiedToIngram = true; r.notifiedAt = new Date().toISOString(); r.notifiedBy = admin ? admin.name : null; r.status = 'en proceso';
            }
          });
        });
        selectedForIngram.clear();
        render();
        showToast('Se abrió tu cliente de correo con el mensaje listo — revisa y presiona enviar ahí.', 'info');
        return;
      }

      try{
        var result = await mcpCap.callTool('Gmail', 'send_message', { to: [ingramEmail], cc: ccList, subject: subject, body: body, htmlBody: htmlBody });
        commit(function(s){
          s.requests.forEach(function(r){
            if(ids.indexOf(r.id)>-1 && puedeEnviarse(r)){
              r.notifiedToIngram = true; r.notifiedAt = new Date().toISOString(); r.notifiedBy = admin ? admin.name : null; r.status = 'en proceso';
            }
          });
        });
        selectedForIngram.clear();
        render();
        showToast('Correo enviado (' + items.length + ' solicitud' + (items.length===1?'':'es') + ').', 'success');
      }catch(err){
        var code = err && err.code;
        if(code==='needs_reauth' || code==='server_not_connected' || code==='selection_required'){
          showToast('Conecta o reconecta Gmail en claude.ai → Ajustes → Conectores.', 'error');
        }else if(code==='blocked_by_policy'){
          showToast('Tu organización bloquea el envío desde este conector.', 'error');
        }else if(code==='approval_required'){
          showToast('Este envío requiere aprobación de tu organización.', 'error');
        }else if(code==='tool_error'){
          showToast('Gmail rechazó el envío: ' + (err.message||'error desconocido'), 'error');
        }else if(code==='not_in_manifest' || code==='not_granted' || code==='capability_disabled'){
          showToast('El envío por Gmail no está disponible en esta vista.', 'error');
        }else{
          showToast('No se pudo enviar el correo. Intenta de nuevo.', 'error');
        }
        console.error(err);
      }
    },

    addType: function(ev){
      ev.preventDefault();
      var f = ev.target;
      var name = f.name.value.trim();
      var price = Number(f.price.value)||0;
      if(!name) return;
      commit(function(s){ s.licenseTypes.push({ id: uid('lt'), name: name, price: price, active: true }); });
      showToast('Tipo de licencia añadido.', 'success');
    },
    setTypePrice: function(id, val){
      var price = Number(val)||0;
      commit(function(s){ var t = s.licenseTypes.find(function(x){return x.id===id;}); if(t){ t.price = price; s.requests.forEach(function(r){ if(r.licenseTypeId===id && r.status==='pendiente') r.price = price; }); } });
    },
    toggleTypeActive: function(id){
      commit(function(s){ var t = s.licenseTypes.find(function(x){return x.id===id;}); if(t) t.active = !t.active; });
    },
    removeType: function(id){
      commit(function(s){ s.licenseTypes = s.licenseTypes.filter(function(x){ return x.id!==id; }); });
      showToast('Tipo de licencia eliminado.', 'success');
    },

    // Proyectos. La primera edición materializa la lista semilla en STATE
    // para que a partir de ahí sea totalmente administrable.
    addProject: async function(ev){
      ev.preventDefault();
      var name = ev.target.name.value.trim();
      if(!name) return;
      if(projectNames(false).some(function(p){ return p.toLowerCase()===name.toLowerCase(); })){
        showToast('Ese proyecto ya existe.', 'error'); return;
      }
      var ok = await commitSynced(function(s){
        if(!Array.isArray(s.projects) || !s.projects.length) s.projects = projectList().slice();
        s.projects.push({ id: uid('pj'), name: name, active: true });
      });
      showToast(ok ? 'Proyecto añadido. Ya aparece en el formulario del cliente.' : 'Se añadió localmente, pero no se pudo sincronizar. Reintenta.', ok ? 'success' : 'error');
    },
    toggleProjectActive: async function(id){
      var ok = await commitSynced(function(s){
        if(!Array.isArray(s.projects) || !s.projects.length) s.projects = projectList().slice();
        var p = s.projects.find(function(x){ return x.id===id; });
        if(p) p.active = p.active===false;
      });
      if(!ok) showToast('No se pudo sincronizar el cambio. Reintenta.', 'error');
    },
    removeProject: async function(id){
      var ok = await commitSynced(function(s){
        if(!Array.isArray(s.projects) || !s.projects.length) s.projects = projectList().slice();
        s.projects = s.projects.filter(function(x){ return x.id!==id; });
      });
      showToast(ok ? 'Proyecto eliminado.' : 'Se eliminó localmente, pero no se pudo sincronizar. Reintenta.', ok ? 'success' : 'error');
    },

    addClient: async function(ev){
      ev.preventDefault();
      var f = ev.target;
      var username = f.username.value.trim();
      var passwordValue = f.password.value;
      if(STATE.users.some(function(u){ return u.username===username; })){ showToast('Ese usuario ya existe.', 'error'); return; }
      var hash = await hashPassword(passwordValue);
      var synced = await commitSynced(function(s){
        s.users.push({ id: uid('u'), username: username, passwordHash: hash, role: 'client', name: f.name.value.trim(), email: (f.email && f.email.value.trim()) || '', active: true });
      });
      showToast(synced
        ? 'Cuenta de cliente creada. Ya puede iniciar sesión en el portal.'
        : 'Cuenta creada solo en este navegador: no se pudo sincronizar, el cliente aún no podrá entrar. Reintenta.', synced ? 'success' : 'error');
    },
    toggleUserActive: function(id){
      commit(function(s){ var u = s.users.find(function(x){return x.id===id;}); if(u) u.active = !u.active; });
    },
    startEditClient: function(id){
      editingClientId = id;
      render();
    },
    cancelEditClient: function(){
      editingClientId = null;
      render();
    },
    saveEditClient: async function(id){
      var nameEl = document.getElementById('edit-client-name-'+id);
      var usernameEl = document.getElementById('edit-client-username-'+id);
      var passwordEl = document.getElementById('edit-client-password-'+id);
      var emailEl = document.getElementById('edit-client-email-'+id);
      var name = (nameEl.value||'').trim();
      var username = (usernameEl.value||'').trim();
      var newPassword = passwordEl.value; // vacío = no cambiar la contraseña
      if(!name || !username){ showToast('Completa nombre y usuario.', 'error'); return; }
      var clash = STATE.users.some(function(u){ return u.id!==id && u.username===username; });
      if(clash){ showToast('Ese usuario ya existe.', 'error'); return; }
      var newHash = newPassword ? await hashPassword(newPassword) : null;
      editingClientId = null;
      var synced = await commitSynced(function(s){
        var u = s.users.find(function(x){ return x.id===id; });
        if(!u) return;
        var oldUsername = u.username;
        u.name = name; u.username = username;
        if(emailEl) u.email = (emailEl.value||'').trim();
        if(newHash){ u.passwordHash = newHash; delete u.password; }
        if(oldUsername!==username){
          s.requests.forEach(function(r){ if(r.clientUsername===oldUsername) r.clientUsername = username; });
        }
      });
      if(!synced){
        showToast('El cambio no se sincronizó: el cliente seguirá entrando con sus datos anteriores. Reintenta.', 'error');
      } else {
        showToast(newHash
          ? 'Cliente actualizado. La nueva contraseña ya vale para su login.'
          : 'Cliente actualizado.', 'success');
      }
    },
    removeUser: function(id){
      commit(function(s){ s.users = s.users.filter(function(x){ return x.id!==id; }); });
      showToast('Cuenta eliminada.', 'success');
    },

    setReportFilter: function(k,v){ reportFilter[k]=v; saveUiState(); render(); },
    setReportMonth: function(v){ reportMonth = v; render(); },
    exportReport: async function(){
      var list = STATE.requests.filter(function(r){
        if(reportFilter.cliente!=='todos' && r.clientUsername!==reportFilter.cliente) return false;
        if(reportFilter.estado!=='todos' && r.status!==reportFilter.estado) return false;
        if(reportFilter.tipo!=='todos' && r.licenseTypeId!==reportFilter.tipo) return false;
        if(reportFilter.proyecto!=='todos' && r.project!==reportFilter.proyecto) return false;
        return true;
      }).sort(function(a,b){ return a.requestedAt<b.requestedAt?-1:1; });

      if(typeof ExcelJS==='undefined'){
        showToast('No se pudo cargar el generador de Excel.', 'error');
        return;
      }

      // Etiquetas legibles de los filtros activos, para el encabezado del reporte.
      var clientesAll = STATE.users.filter(function(u){ return u.role==='client'; });
      var clienteLabel = reportFilter.cliente==='todos' ? 'Todos'
        : (clientesAll.find(function(c){ return c.username===reportFilter.cliente; })||{}).name || reportFilter.cliente;
      var estadoLabel = reportFilter.estado==='todos' ? 'Todos' : reportFilter.estado;
      var tipoLabel = reportFilter.tipo==='todos' ? 'Todos'
        : (STATE.licenseTypes.find(function(t){ return t.id===reportFilter.tipo; })||{}).name || reportFilter.tipo;
      var proyectoLabel = reportFilter.proyecto==='todos' ? 'Todos' : reportFilter.proyecto;

      var aprobadasList = list.filter(esAprobada);
      var totalAprobado = aprobadasList.reduce(function(s,r){ return s + montoTotal(r); }, 0);
      var totalLicencias = list.reduce(function(s,r){ return s + Number(r.quantity||1); }, 0);
      var generadoEl = new Date().toLocaleString('es-PE', {dateStyle:'long', timeStyle:'short'});

      // Paleta de marca Moventi (misma que se usa en los reportes Word).
      var C = { dark:'FF1A2535', teal:'FF00C8B4', tealDark:'FF009B8B', gray:'FF6B7280',
        white:'FFFFFFFF', lightGray:'FFF2F4F6', lightTeal:'FFE6FBF8', midGray:'FFD1D5DB' };
      var MONEY_FMT = '"US$" #,##0.00';

      var wb = new ExcelJS.Workbook();
      wb.creator = 'Portal de Licencias — Moventi';
      wb.created = new Date();

      /* ---------- Una sola hoja: encabezado + tabla + total ---------- */
      var ws = wb.addWorksheet('Reporte', { views:[{ showGridLines:false }] });
      var cols = [
        {header:'Fecha de solicitud', key:'fsol', width:14},
        {header:'Cliente', key:'cli', width:26},
        {header:'Tipo de licencia', key:'tipo', width:28},
        {header:'Proyecto', key:'proy', width:20},
        {header:'Cantidad', key:'cant', width:10},
        {header:'Fecha requerida', key:'freq', width:14},
        {header:'Estado', key:'est', width:12},
        {header:'Precio unitario (US$)', key:'punit', width:16},
        {header:'MONTO TOTAL (US$)', key:'mtotal', width:18},
        {header:'Fecha de activación', key:'fact', width:14},
        {header:'Fecha de vencimiento', key:'fven', width:16},
        {header:'Gestionado por', key:'gest', width:20}
      ];
      var N = cols.length;
      var MONTO_COL = 9; // índice 1-based de "MONTO TOTAL (US$)"
      var lastColLetter = String.fromCharCode(64+N); // 'L'

      // --- Encabezado del reporte (título, filtros, fecha) ---
      ws.mergeCells('A1:'+lastColLetter+'1');
      ws.getCell('A1').value = 'Reporte de Licencias';
      ws.getCell('A1').font = { bold:true, size:16, color:{argb:C.dark} };
      ws.getRow(1).height = 22;

      ws.mergeCells('A2:'+lastColLetter+'2');
      ws.getCell('A2').value = 'Cliente: '+clienteLabel+'  ·  Estado: '+estadoLabel+'  ·  Tipo: '+tipoLabel+'  ·  Proyecto: '+proyectoLabel;
      ws.getCell('A2').font = { size:10, color:{argb:C.gray} };

      ws.mergeCells('A3:'+lastColLetter+'3');
      ws.getCell('A3').value = 'Mes de cierre: '+reportMonth+'   ·   Generado: '+generadoEl+'   ·   Total de solicitudes: '+list.length+'   ·   Licencias aprobadas/vigentes: '+aprobadasList.length;
      ws.getCell('A3').font = { size:10, italic:true, color:{argb:C.gray} };

      // Bloque destacado con el número que importa, arriba de la tabla.
      ws.mergeCells('A5:'+String.fromCharCode(64+MONTO_COL-1)+'5');
      ws.getCell('A5').value = 'MONTO TOTAL (US$) — usar este valor (ya prorrateado)';
      ws.mergeCells(String.fromCharCode(64+MONTO_COL)+'5:'+lastColLetter+'5');
      ws.getCell(String.fromCharCode(64+MONTO_COL)+'5').value = totalAprobado;
      ws.getCell(String.fromCharCode(64+MONTO_COL)+'5').numFmt = MONEY_FMT;
      for(var cc=1; cc<=N; cc++){
        var cell5 = ws.getRow(5).getCell(cc);
        cell5.fill = { type:'pattern', pattern:'solid', fgColor:{argb:C.teal} };
        cell5.font = { bold:true, size:13, color:{argb:C.white} };
      }
      ws.getCell('A5').alignment = { vertical:'middle' };
      ws.getCell(String.fromCharCode(64+MONTO_COL)+'5').alignment = { vertical:'middle', horizontal:'right' };
      ws.getRow(5).height = 24;

      // --- Encabezado de la tabla ---
      var HEADER_ROW = 7;
      var headerRow = ws.getRow(HEADER_ROW);
      cols.forEach(function(col, i){
        var cell = headerRow.getCell(i+1);
        cell.value = col.header;
        cell.font = { bold:true, color:{argb:C.white} };
        cell.fill = { type:'pattern', pattern:'solid', fgColor:{argb: (i+1)===MONTO_COL ? C.tealDark : C.dark} };
        cell.alignment = { vertical:'middle', horizontal: (i+1)>=5 && (i+1)<=9 ? 'right' : 'left' };
      });
      headerRow.getCell(MONTO_COL).note = 'Valor a utilizar: ya incluye el prorrateo cuando aplica.';
      headerRow.height = 20;
      cols.forEach(function(col, i){ ws.getColumn(i+1).width = col.width; });

      list.forEach(function(r, idx){
        var row = ws.getRow(HEADER_ROW+1+idx);
        row.getCell(1).value = dateOnly(r.requestedAt)||'';
        row.getCell(2).value = r.clientName;
        row.getCell(3).value = r.licenseTypeName;
        row.getCell(4).value = r.project||'';
        row.getCell(5).value = Number(r.quantity||1);
        row.getCell(6).value = r.neededFrom||'';
        row.getCell(7).value = r.status;
        row.getCell(8).value = precioUnitFinal(r);
        row.getCell(9).value = montoTotal(r);
        row.getCell(10).value = r.activatedAt||'';
        row.getCell(11).value = fechaVencimiento(r)||'';
        row.getCell(12).value = r.activatedBy||r.notifiedBy||'';

        row.getCell(8).numFmt = MONEY_FMT; row.getCell(8).alignment = {horizontal:'right'};
        row.getCell(9).numFmt = MONEY_FMT; row.getCell(9).alignment = {horizontal:'right'};
        row.getCell(9).font = { bold:true, color:{argb:C.tealDark} };
        row.getCell(9).fill = { type:'pattern', pattern:'solid', fgColor:{argb:C.lightTeal} };
        row.getCell(5).alignment = {horizontal:'right'};
        if(idx % 2 === 1){
          [1,2,3,4,5,6,7,10,11,12].forEach(function(c){
            row.getCell(c).fill = { type:'pattern', pattern:'solid', fgColor:{argb:C.lightGray} };
          });
        }
      });
      ws.autoFilter = { from:{row:HEADER_ROW,column:1}, to:{row:HEADER_ROW,column:N} };
      ws.views = [{ state:'frozen', ySplit:HEADER_ROW }];

      var lastDataRow = HEADER_ROW + list.length;
      if(list.length){
        var totRowNum = lastDataRow + 2;
        var totRow = ws.getRow(totRowNum);
        totRow.getCell(1).value = 'Total de solicitudes en este reporte';
        totRow.getCell(5).value = list.length;
        totRow.getCell(1).font = { bold:true, color:{argb:C.dark} };
        totRow.getCell(5).font = { bold:true };
        totRow.getCell(5).alignment = { horizontal:'right' };

        var granRowNum = totRowNum+1;
        ws.mergeCells('A'+granRowNum+':H'+granRowNum);
        var granRow = ws.getRow(granRowNum);
        granRow.getCell(1).value = 'MONTO TOTAL APROBADO (US$) — usar este valor';
        granRow.getCell(MONTO_COL).value = totalAprobado;
        granRow.getCell(MONTO_COL).numFmt = MONEY_FMT;
        for(var c=1;c<=MONTO_COL;c++){
          granRow.getCell(c).fill = { type:'pattern', pattern:'solid', fgColor:{argb:C.teal} };
          granRow.getCell(c).font = { bold:true, color:{argb:C.white} };
        }
        granRow.getCell(MONTO_COL).alignment = { horizontal:'right' };
        granRow.height = 22;
      }

      var buf = await wb.xlsx.writeBuffer();
      var fname = 'reporte_licencias_cierre_'+reportMonth+'.xlsx';
      downloadBinary(fname, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
  };
  window.App = App;

  /* ================= boot ================= */
  async function boot(){
    initTheme();
    restoreUiState();
    try{
      if(window.claude && window.claude.use){
        artifactCap = await window.claude.use('artifact');
        downloadsCap = await window.claude.use('downloads');
        mcpCap = await window.claude.use('mcp');
      }
    }catch(e){ console.warn('capability init failed', e); }
    if(!artifactCap){
      // Cargamos primero desde localStorage (por si el backend tarda o no
      // responde, no arrancamos en blanco), y lo reemplazamos si el backend
      // (Vercel Blob) contesta con datos.
      var savedLocal = loadLocalFallbackState();
      if(savedLocal) STATE = savedLocal;
      // El login (con los datos semilla/locales) se muestra de inmediato:
      // no bloqueamos la primera pantalla esperando al backend, porque
      // Vercel Blob a veces tarda varios segundos (o más) en responder y
      // eso dejaba la pantalla en negro todo ese tiempo. La sincronización
      // con el backend sigue en segundo plano y vuelve a pintar cuando
      // llega.
      capReady = true;
      render();
      var remoteRes = await fetchRemoteState();
      if(remoteRes){
        stateBackendAvailable = true;
        if(remoteRes.state){
          STATE = remoteRes.state;
          baseRemoteState = JSON.parse(JSON.stringify(STATE));
          saveLocalFallbackState();
          // En segundo plano, sin bloquear ni volver a pintar: si alguna
          // cuenta de cliente quedó con la contraseña en texto plano de
          // antes de este cambio, la migra a hash.
          migrateLegacyClientPasswords();
          // Igual, por si quedaron tipos de licencia duplicados (mismo
          // concepto con nombre distinto) de antes de normalizar el nombre.
          if(mergeDuplicateLicenseTypes(STATE)){
            saveLocalFallbackState();
            saveRemoteState(STATE).then(function(){
              baseRemoteState = JSON.parse(JSON.stringify(STATE));
              if(currentUser()) render();
            }).catch(function(e){ console.error(e); });
          }
        } else {
          // El backend aún no tiene nada guardado (primera vez): lo
          // inicializamos con el estado semilla/actual de este navegador.
          try{
            await saveRemoteState(STATE);
            baseRemoteState = JSON.parse(JSON.stringify(STATE));
          }catch(e){ console.error(e); }
        }
        // Si ya hay una sesión iniciada (currentUser), sí conviene refrescar
        // la pantalla con los datos remotos recién llegados. Pero si seguimos
        // en el login, NO volvemos a pintar: el formulario de login no
        // depende de STATE (los usuarios se leen recién al hacer submit), y
        // repintar aquí borraría lo que la persona ya haya escrito en
        // usuario/contraseña mientras esperaba al backend.
        if(currentUser()) render();
      } else {
        showToast('No se pudo conectar con el servidor: los datos se guardan solo en este navegador mientras tanto.', 'info');
      }
      return;
    }
    capReady = true;
    render();
    if(stateBackendAvailable){
      document.addEventListener('visibilitychange', function(){
        if(document.visibilityState === 'visible') refreshFromRemoteIfIdle();
      });
      window.addEventListener('focus', function(){ refreshFromRemoteIfIdle(); });
      setInterval(function(){
        if(document.visibilityState === 'visible') refreshFromRemoteIfIdle();
      }, 30000);
    }
  }
  boot();
})();
