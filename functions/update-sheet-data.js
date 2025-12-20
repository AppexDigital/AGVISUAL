// functions/update-sheet-data.js
// v4.0 - SISTEMA COMPLETO: Reservas Públicas + Notificaciones SMTP

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const nodemailer = require('nodemailer'); // Herramienta de correo
const { validateGoogleToken } = require('./google-auth-helper');

// --- 1. CONEXIÓN A GOOGLE (HELPERS) ---
async function getServices(publicAuth = false) {
  // Usamos Service Account (Tus credenciales de servidor)
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
  });
  
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  return { doc, drive: google.drive({ version: 'v3', auth }) };
}

function getRealHeader(sheet, name) {
    if (!sheet || !sheet.headerValues) return undefined;
    const headers = sheet.headerValues;
    const target = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return headers.find(h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '') === target);
}

function getDataVal(dataObj, keyName) {
    if (!dataObj) return undefined;
    const target = keyName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = Object.keys(dataObj).find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === target);
    return key ? dataObj[key] : undefined;
}

async function deleteChildRows(doc, childSheetName, parentIdHeader, parentIdValue) {
    try {
        const childSheet = doc.sheetsByTitle[childSheetName];
        if (!childSheet) return;
        await childSheet.loadHeaderRow();
        const rows = await childSheet.getRows();
        const header = getRealHeader(childSheet, parentIdHeader);
        if (!header) return;
        const rowsToDelete = rows.filter(r => String(r.get(header)).trim() === String(parentIdValue).trim());
        for (const row of rowsToDelete) { await row.delete(); }
    } catch (e) { console.warn(`Error cascada ${childSheetName}:`, e.message); }
}

// --- 2. SISTEMA DE ENVÍO DE CORREOS ---
async function sendReservationEmails(doc, bookingData, allOperations) {
    try {
        // A. Validar configuración en Netlify
        if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
            console.warn("⚠️ SMTP no configurado. Saltando correos.");
            return;
        }

        // B. Configurar el "Transportista" (Gmail)
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.SMTP_USER, // Tu correo temporal
                pass: process.env.SMTP_PASS  // Tu clave de 16 letras
            }
        });

        // C. Obtener datos reales de la empresa (Desde el Excel)
        // Esto sirve para que el correo diga "AG Visual" y no "Tu Nombre"
        let adminEmailDestino = process.env.SMTP_USER; // A dónde llega la alerta (por defecto al mismo)
        let companyName = "AG Visual"; 
        
        try {
            const idSheet = doc.sheetsByTitle['Identidad'];
            if (idSheet) {
                await idSheet.loadHeaderRow();
                const rows = await idSheet.getRows();
                // Buscamos el correo real del negocio para enviarle la alerta a él
                const emailRow = rows.find(r => 
                    (r.get('key') === 'contact_email' || r.get('section') === 'contact_email')
                );
                const nameRow = rows.find(r => 
                    (r.get('key') === 'legal_commercial_name' || r.get('section') === 'legal_commercial_name')
                );
                
                if (emailRow) {
                    const val = emailRow.get('value') || emailRow.get('content');
                    if(val && val.includes('@')) adminEmailDestino = val; // Si hay un correo válido en el Excel, usamos ese para recibir la alerta
                }
                if (nameRow) {
                    const val = nameRow.get('value') || nameRow.get('content');
                    if(val) companyName = val;
                }
            }
        } catch (e) { console.warn("No se pudo leer hoja Identidad:", e.message); }

        // D. Generar lista de productos (HTML)
        const detailsOps = allOperations.filter(op => 
            op.sheet === 'BookingsDetails' && 
            op.action === 'add' && 
            String(op.data.bookingId) === String(bookingData.id)
        );

        const itemsListHTML = detailsOps.map(d => `
            <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 8px 0; color: #333;">${d.data.itemName}</td>
                <td style="padding: 8px 0; text-align: right; color: #555;">$${parseFloat(d.data.lineTotal).toFixed(2)}</td>
            </tr>
        `).join('') || `<tr><td colspan="2">${bookingData.itemName}</td></tr>`;

        // E. Plantilla Correo Cliente
        const clientHtml = `
            <div style="font-family: 'Helvetica', sans-serif; max-width: 600px; margin: 0 auto; color: #333; line-height: 1.6;">
                <div style="background-color: #000; color: #fff; padding: 20px; text-align: center;">
                    <h1 style="margin: 0; font-family: 'Garamond', serif; letter-spacing: 2px;">${companyName}</h1>
                </div>
                <div style="padding: 30px; border: 1px solid #eee; border-top: none;">
                    <h2 style="color: #000; margin-top: 0;">¡Solicitud Recibida!</h2>
                    <p>Hola <strong>${bookingData.customerName}</strong>,</p>
                    <p>Hemos recibido tu solicitud. Aquí tienes el resumen:</p>
                    
                    <div style="background-color: #f9f9f9; padding: 15px; margin: 20px 0; border-left: 4px solid #000;">
                        <p style="margin: 0;"><strong>Reserva:</strong> ${bookingData.id}</p>
                        <p style="margin: 5px 0;"><strong>Fechas:</strong> ${bookingData.startDate} al ${bookingData.endDate}</p>
                    </div>

                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                        <thead>
                            <tr style="border-bottom: 2px solid #000;">
                                <th style="text-align: left; padding: 10px 0;">Servicio</th>
                                <th style="text-align: right; padding: 10px 0;">Total</th>
                            </tr>
                        </thead>
                        <tbody>${itemsListHTML}</tbody>
                        <tfoot>
                            <tr>
                                <td style="padding-top: 15px; font-weight: bold;">Total:</td>
                                <td style="padding-top: 15px; text-align: right; font-weight: bold; font-size: 1.2em;">$${parseFloat(bookingData.totalPrice).toFixed(2)}</td>
                            </tr>
                        </tfoot>
                    </table>
                    <p style="font-size: 0.9em; color: #666;">Te contactaremos pronto para confirmar.</p>
                </div>
            </div>
        `;

        // F. Plantilla Correo Admin
        const adminHtml = `
            <div style="font-family: sans-serif; color: #333;">
                <h3>🔔 Nueva Reserva Web (${bookingData.id})</h3>
                <p><strong>Cliente:</strong> ${bookingData.customerName}</p>
                <p><strong>Contacto:</strong> ${bookingData.customerPhone} | ${bookingData.customerEmail}</p>
                <p><strong>Total:</strong> $${parseFloat(bookingData.totalPrice).toFixed(2)}</p>
                <hr>
                <p>Revisa el Centro de Mando para gestionar.</p>
            </div>
        `;

        // G. Enviar los correos
        // 1. Al Cliente
        await transporter.sendMail({
            from: `"${companyName}" <${process.env.SMTP_USER}>`, // Sale de tu correo temporal con nombre de empresa
            to: bookingData.customerEmail,
            subject: `Reserva #${bookingData.id} - ${companyName}`,
            html: clientHtml,
            replyTo: adminEmailDestino // Si el cliente responde, le llega al correo real del negocio
        });

        // 2. Al Admin (Dueño del negocio)
        await transporter.sendMail({
            from: `"Sistema Web" <${process.env.SMTP_USER}>`,
            to: adminEmailDestino, // Lo sacamos del Excel (Identidad)
            subject: `🔔 Nueva Reserva: ${bookingData.customerName}`,
            html: adminHtml
        });

        console.log(`✅ Correos enviados: ${bookingData.id}`);

    } catch (e) {
        console.error("❌ Error en envío de correo:", e);
        // No lanzamos error para no interrumpir el guardado en Excel si el correo falla
    }
}


// --- 3. FUNCIÓN PRINCIPAL (HANDLER) ---
exports.handler = async (event, context) => {
  // CORS
  if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    let body;
    try { body = JSON.parse(event.body); if (typeof body === 'string') body = JSON.parse(body); } catch (e) { throw new Error('JSON inválido.'); }
    const operations = Array.isArray(body) ? body : [body];

    // --- SEGURIDAD HÍBRIDA (SOLUCIÓN 401) ---
    const hasAdminToken = await validateGoogleToken(event);
    let services;

    if (hasAdminToken) {
        services = await getServices(); // Admin logueado
    } else {
        // Público (Web): Solo permitimos 'add' en tablas de Reserva
        const allowedPublicSheets = ['Bookings', 'BookingsDetails', 'BlockedDates'];
        const isSafePublicRequest = operations.every(op => 
            op.action === 'add' && allowedPublicSheets.includes(op.sheet)
        );

        if (!isSafePublicRequest) {
            return { statusCode: 401, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'No autorizado.' }) };
        }
        services = await getServices(true); // Usamos credenciales del servidor
    }

    const { doc, drive } = services;

    // Procesamiento
    for (const op of operations) {
        if (op.action === 'delete_file_only' && op.data && op.data.fileId) {
            try { await drive.files.update({ fileId: op.data.fileId, requestBody: { trashed: true }, supportsAllDrives: true }); } catch (e) {}
            op._processed = true; 
        }
    }

    const opsBySheet = {};
    operations.forEach(op => { if (!op._processed) { if (!opsBySheet[op.sheet]) opsBySheet[op.sheet] = []; opsBySheet[op.sheet].push(op); } });

    for (const sheetName of Object.keys(opsBySheet)) {
        const sheet = doc.sheetsByTitle[sheetName];
        if (!sheet) continue;
        await sheet.loadHeaderRow();
        const sheetOps = opsBySheet[sheetName];
        
        // Anti-Colisión (Solo Reservas)
        if (sheetName === 'Bookings') {
            const bookingsToAdd = sheetOps.filter(op => op.action === 'add' || op.action === 'update');
            if (bookingsToAdd.length > 0) {
                const blockedSheet = doc.sheetsByTitle['BlockedDates'];
                if (blockedSheet) {
                    await blockedSheet.loadHeaderRow();
                    const blockedRows = await blockedSheet.getRows();
                    const hStart = getRealHeader(blockedSheet, 'startDate');
                    const hEnd = getRealHeader(blockedSheet, 'endDate');
                    const hItem = getRealHeader(blockedSheet, 'itemId');
                    const hBook = getRealHeader(blockedSheet, 'bookingId');

                    if(hStart && hEnd && hItem) {
                        const blocks = blockedRows.map(r => ({ start: new Date(r.get(hStart)), end: new Date(r.get(hEnd)), itemId: r.get(hItem), bookingId: hBook ? r.get(hBook) : null }));
                        for (const op of bookingsToAdd) {
                            if (op.data.status === 'Cancelado') continue;
                            const reqStart = new Date(op.data.startDate); const reqEnd = new Date(op.data.endDate);
                            const conflict = blocks.find(b => {
                                if (b.itemId !== op.data.itemId) return false;
                                if (op.criteria && b.bookingId === op.criteria.id) return false;
                                return reqStart <= b.end && reqEnd >= b.start;
                            });
                            if (conflict) throw new Error(`CONFLICTO: Equipo ya reservado.`);
                        }
                    }
                }
            }
        }

        const adds = sheetOps.filter(op => op.action === 'add');
        const updates = sheetOps.filter(op => op.action === 'update');
        const deletes = sheetOps.filter(op => op.action === 'delete');

        // ADDS
        for (const op of adds) {
            if (!op.data.id && !['Settings', 'About'].includes(sheetName)) { op.data.id = `${sheetName.toLowerCase().slice(0, 5)}_${Date.now()}_${Math.floor(Math.random()*1000)}`; }
            const rowData = {};
            Object.keys(op.data).forEach(k => { const h = getRealHeader(sheet, k); if (h) rowData[h] = op.data[k]; });
            await sheet.addRow(rowData); 
            
            // ---> AQUÍ SE ENVÍA EL CORREO AUTOMÁTICO <---
            // Solo entra si NO tiene token de Admin (es decir, es un cliente público)
            if (sheetName === 'Bookings' && !hasAdminToken) {
                await sendReservationEmails(doc, op.data, operations);
            }
        }

        // UPDATES
        if (updates.length > 0) {
            const rows = await sheet.getRows(); 
            for (const op of updates) {
                const criteriaKey = Object.keys(op.criteria)[0]; const criteriaVal = String(op.criteria[criteriaKey]).trim();
                const realHeaderKey = getRealHeader(sheet, criteriaKey);
                if (!realHeaderKey && ['Settings', 'About'].includes(sheetName)) { await sheet.addRow({ ...op.criteria, ...op.data }); continue; }
                const targetRow = rows.find(r => String(r.get(realHeaderKey)).trim() === criteriaVal);
                if (targetRow) {
                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) { /* Logica Drive */ }
                    if ((sheetName === 'ProjectImages' || sheetName === 'RentalItemImages') && String(op.data.isCover).toLowerCase() === 'si') {
                        const pKey = sheetName === 'ProjectImages' ? 'projectId' : 'itemId';
                        const pHeader = getRealHeader(sheet, pKey); const cHeader = getRealHeader(sheet, 'isCover');
                        if (pHeader && cHeader) { const currentPId = targetRow.get(pHeader); for (const r of rows) { if (r !== targetRow && String(r.get(pHeader)) === String(currentPId) && String(r.get(cHeader)).toLowerCase() === 'si') { r.set(cHeader, 'No'); await r.save(); } } }
                    }
                    let hasChanges = false;
                    Object.keys(op.data).forEach(key => { const h = getRealHeader(sheet, key); if (h) { targetRow.set(h, op.data[key]); hasChanges = true; } });
                    if (hasChanges) await targetRow.save();
                }
            }
        }

        // DELETES
        if (deletes.length > 0) {
            const currentRows = await sheet.getRows(); 
            for (const op of deletes) {
                const criteriaKey = Object.keys(op.criteria)[0]; const criteriaVal = String(op.criteria[criteriaKey]).trim();
                const realKeyHeader = getRealHeader(sheet, criteriaKey); if (!realKeyHeader) continue;
                if (sheetName === 'RentalCategories') { /* Validación Hijos */ }
                const row = currentRows.find(r => String(r.get(realKeyHeader)).trim() === criteriaVal);
                if (row) {
                    let fileId = getDataVal(op.data, 'fileId');
                    if (!fileId) { const hFile = getRealHeader(sheet, 'fileId'); if (hFile) fileId = row.get(hFile); }
                    if (fileId) { try { await drive.files.update({ fileId: fileId, requestBody: { trashed: true }, supportsAllDrives: true }); } catch(e){} }
                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) {
                        const hFolder = getRealHeader(sheet, 'driveFolderId'); const folderId = hFolder ? row.get(hFolder) : null;
                        if (folderId) { try { await drive.files.update({ fileId: folderId, requestBody: { trashed: true }, supportsAllDrives: true }); } catch(e){} }
                        if (sheetName === 'Projects') await deleteChildRows(doc, 'ProjectImages', 'projectId', criteriaVal);
                        if (sheetName === 'RentalItems') { await deleteChildRows(doc, 'RentalItemImages', 'itemId', criteriaVal); await deleteChildRows(doc, 'BlockedDates', 'itemId', criteriaVal); await deleteChildRows(doc, 'Bookings', 'itemId', criteriaVal); }
                        if (sheetName === 'Services') { await deleteChildRows(doc, 'ServiceImages', 'serviceId', criteriaVal); await deleteChildRows(doc, 'ServiceContentBlocks', 'serviceId', criteriaVal); }
                    }
                    await row.delete();
                }
            }
        }
    }
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ message: 'OK' }) };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: error.message }) };
  }
};
