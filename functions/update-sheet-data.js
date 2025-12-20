// functions/update-sheet-data.js
// v6.0 - PRO EMAILS: Diseño Editorial para Admin + Logo Negro + Desglose Fiscal

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { validateGoogleToken } = require('./google-auth-helper');

// --- 1. CONEXIÓN A GOOGLE (HELPERS) ---
async function getServices(publicAuth = false) {
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

// --- 2. SISTEMA DE CORREOS PRO (V6.0) ---
async function sendReservationEmails(doc, bookingData, allOperations) {
    try {
        if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
            console.warn("⚠️ SMTP no configurado.");
            return;
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });

        // --- A. OBTENER IDENTIDAD DEL NEGOCIO ---
        let config = {
            adminEmail: process.env.SMTP_USER,
            companyName: "AG Visual",
            logoWhiteUrl: "", 
            logoBlackUrl: "", // Nuevo: Para fondo blanco
            adminUrl: "#", 
            webUrl: "#",   
            phone: "",
            contactEmail: ""
        };
        
        try {
            // 1. Hoja 'Identidad' (Texto)
            const idSheet = doc.sheetsByTitle['Identidad'];
            if (idSheet) {
                await idSheet.loadHeaderRow();
                const rows = await idSheet.getRows();
                const getVal = (k) => {
                    const r = rows.find(row => row.get('key') === k);
                    return r ? r.get('value') : "";
                };
                const emailSheet = getVal('contact_email');
                if(emailSheet && emailSheet.includes('@')) config.adminEmail = emailSheet;
                
                config.companyName = getVal('legal_commercial_name') || config.companyName;
                config.adminUrl = getVal('admin_url');
                config.webUrl = getVal('website_url');
                config.phone = getVal('contact_phone');
                config.contactEmail = getVal('contact_email');
            }

            // 2. Hoja 'ImagenesIdentidad' (Logos)
            const imgSheet = doc.sheetsByTitle['ImagenesIdentidad'];
            if (imgSheet) {
                await imgSheet.loadHeaderRow();
                const rows = await imgSheet.getRows();
                
                const whiteRow = rows.find(r => r.get('key') === 'logo_white');
                if (whiteRow) config.logoWhiteUrl = whiteRow.get('imageUrl');

                const blackRow = rows.find(r => r.get('key') === 'logo_black');
                if (blackRow) config.logoBlackUrl = blackRow.get('imageUrl');
            }
        } catch (e) { console.warn("Error leyendo Identidad:", e.message); }


        // --- B. PROCESAMIENTO DE ITEMS Y CÁLCULOS ---
        const detailsOps = allOperations.filter(op => 
            op.sheet === 'BookingsDetails' && op.action === 'add' && String(op.data.bookingId) === String(bookingData.id)
        );

        let subtotalGeneral = 0;
        let ivaGeneral = 0;

        // Calculamos totales primero para tenerlos listos
        detailsOps.forEach(d => {
            const price = parseFloat(d.data.lineTotal || 0);
            const hasTax = String(d.data.itemHasTax).toLowerCase() === 'si';
            let lineBase = price;
            let lineTax = 0;

            if (hasTax) {
                lineBase = price / 1.13;
                lineTax = price - lineBase;
            }
            subtotalGeneral += lineBase;
            ivaGeneral += lineTax;
        });

        // Generador de filas HTML
        const generateRows = (isAdmin) => detailsOps.map(d => {
            const price = parseFloat(d.data.lineTotal || 0);
            const imgUrl = d.data.itemImage || ""; 
            const dateStr = `${new Date(d.data.startDate).toLocaleDateString()} - ${new Date(d.data.endDate).toLocaleDateString()}`;
            
            const imgHtml = imgUrl 
                ? `<img src="${imgUrl}" alt="img" style="width: 40px; height: 40px; object-fit: cover; border-radius: 4px; display: block;">` 
                : `<div style="width: 40px; height: 40px; background: #eee; border-radius: 4px;"></div>`;

            // Estilos sutilmente diferentes
            const borderColor = isAdmin ? "#eee" : "#333";
            const textColor = isAdmin ? "#333" : "#fff";
            const subTextColor = isAdmin ? "#666" : "#aaa";

            return `
            <tr>
                <td style="padding: 12px 0; border-bottom: 1px solid ${borderColor}; width: 50px;">${imgHtml}</td>
                <td style="padding: 12px 0; border-bottom: 1px solid ${borderColor}; color: ${textColor};">
                    <span style="font-weight: 600; font-size: 14px;">${d.data.itemName}</span><br>
                    <span style="font-size: 11px; color: ${subTextColor};">${dateStr}</span>
                </td>
                <td style="padding: 12px 0; border-bottom: 1px solid ${borderColor}; text-align: right; color: ${textColor}; font-weight: 500;">$${price.toFixed(2)}</td>
            </tr>`;
        }).join('');

        const rowsAdmin = generateRows(true);
        const rowsClient = generateRows(false); 


        // --- C. PLANTILLA CLIENTE (Oscuro - Elegante) ---
        const logoHeaderClient = config.logoWhiteUrl 
            ? `<img src="${config.logoWhiteUrl}" alt="${config.companyName}" style="max-width: 160px; height: auto;">`
            : `<h1 style="color: #fff; font-family: serif;">${config.companyName}</h1>`;

        const clientHtml = `
            <div style="font-family: 'Helvetica', sans-serif; max-width: 600px; margin: 0 auto; background-color: #000; color: #fff;">
                <div style="padding: 40px 20px; text-align: center; border-bottom: 1px solid #222;">
                    ${logoHeaderClient}
                </div>
                <div style="padding: 40px 30px;">
                    <h2 style="color: #fff; margin: 0 0 10px 0; text-align: center; font-family: 'Garamond', serif; font-size: 28px; font-weight: 400;">Solicitud Recibida</h2>
                    <p style="text-align: center; color: #888; margin-bottom: 40px; font-size: 14px;">Hemos recibido tu solicitud. Validaremos disponibilidad y te contactaremos.</p>
                    
                    <div style="text-align: center; margin-bottom: 40px;">
                        <span style="display: inline-block; border: 1px solid #333; padding: 10px 20px; border-radius: 4px; letter-spacing: 2px; font-weight: bold;">${bookingData.id}</span>
                    </div>

                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
                        ${rowsClient}
                    </table>

                    <div style="text-align: right; border-top: 1px solid #333; padding-top: 20px;">
                        <p style="margin: 3px 0; color: #888; font-size: 13px;">Subtotal: $${subtotalGeneral.toFixed(2)}</p>
                        <p style="margin: 3px 0; color: #888; font-size: 13px;">I.V.A.: $${ivaGeneral.toFixed(2)}</p>
                        <p style="margin: 10px 0 0 0; font-size: 22px; font-weight: bold;">$${parseFloat(bookingData.totalPrice).toFixed(2)}</p>
                    </div>

                    <div style="text-align: center; margin-top: 50px;">
                        <a href="${config.webUrl}" style="background-color: #fff; color: #000; padding: 14px 30px; text-decoration: none; font-weight: bold; border-radius: 50px; font-size: 14px;">Volver a la Web</a>
                    </div>
                </div>
                <div style="background: #111; padding: 20px; text-align: center; color: #555; font-size: 11px;">
                    <p style="margin: 0;">${config.companyName} | ${config.contactEmail}</p>
                </div>
            </div>
        `;

        // --- D. PLANTILLA ADMIN (Claro - Editorial - Completo) ---
        // Usa Logo Negro. Si no hay, usa texto negro.
        const logoHeaderAdmin = config.logoBlackUrl 
            ? `<img src="${config.logoBlackUrl}" alt="${config.companyName}" style="max-width: 140px; height: auto;">`
            : `<h1 style="color: #000; font-family: serif; margin: 0;">${config.companyName}</h1>`;

        const adminHtml = `
            <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; color: #1a1a1a; border: 1px solid #eaeaea;">
                
                <div style="padding: 40px 0; text-align: center;">
                    ${logoHeaderAdmin}
                </div>
                
                <div style="text-align: center; margin-bottom: 40px;">
                    <h2 style="font-family: 'Garamond', Georgia, serif; font-weight: 400; font-size: 26px; margin: 0; color: #111;">Nueva Reserva Recibida</h2>
                    <p style="color: #666; font-size: 14px; margin-top: 5px;">ID: <strong>${bookingData.id}</strong></p>
                </div>

                <div style="padding: 0 40px 40px 40px;">
                    
                    <div style="background-color: #f9f9f9; padding: 25px; border-radius: 2px; margin-bottom: 30px;">
                        <h3 style="margin: 0 0 15px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #888;">Detalles del Cliente</h3>
                        <div style="font-size: 14px; line-height: 1.8;">
                            <div style="margin-bottom: 4px;"><strong>${bookingData.customerName}</strong></div>
                            <div style="color: #444;">ID: ${bookingData.customerCedula || 'N/A'}</div>
                            <div style="color: #444;"><a href="tel:${bookingData.customerPhone}" style="color: #1a1a1a; text-decoration: none;">${bookingData.customerPhone}</a></div>
                            <div style="color: #444;"><a href="mailto:${bookingData.customerEmail}" style="color: #1a1a1a; text-decoration: none;">${bookingData.customerEmail}</a></div>
                            <div style="color: #444; margin-top: 5px; font-style: italic;">${bookingData.customerAddress || 'Sin dirección'}</div>
                        </div>
                    </div>

                    <h3 style="margin: 0 0 10px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #888; border-bottom: 1px solid #eee; padding-bottom: 10px;">Equipos Solicitados</h3>
                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                        ${rowsAdmin}
                    </table>

                    <div style="text-align: right; margin-top: 20px;">
                        <p style="margin: 3px 0; color: #666; font-size: 13px;">Subtotal: $${subtotalGeneral.toFixed(2)}</p>
                        <p style="margin: 3px 0; color: #666; font-size: 13px;">I.V.A.: $${ivaGeneral.toFixed(2)}</p>
                        <p style="margin: 10px 0 0 0; font-size: 20px; font-weight: 600; font-family: 'Garamond', serif;">Total: $${parseFloat(bookingData.totalPrice).toFixed(2)}</p>
                    </div>

                    <div style="text-align: center; margin-top: 45px;">
                        <a href="${config.adminUrl}" style="background-color: #1a1a1a; color: #ffffff; padding: 15px 35px; text-decoration: none; font-size: 13px; font-weight: 600; letter-spacing: 0.5px; border-radius: 2px;">
                            IR AL CENTRO DE MANDO
                        </a>
                    </div>

                </div>
                
                <div style="background-color: #fcfcfc; border-top: 1px solid #eaeaea; padding: 15px; text-align: center; color: #999; font-size: 11px;">
                    Notificación automática del sistema de reservas
                </div>
            </div>
        `;

        // E. ENVIAR
        await transporter.sendMail({
            from: `"${config.companyName}" <${process.env.SMTP_USER}>`,
            to: bookingData.customerEmail,
            subject: `Solicitud Recibida #${bookingData.id}`,
            html: clientHtml,
            replyTo: config.adminEmail
        });

        await transporter.sendMail({
            from: `"Notificaciones Web" <${process.env.SMTP_USER}>`,
            to: config.adminEmail,
            subject: `Reserva Web: ${bookingData.customerName}`,
            html: adminHtml
        });

        console.log(`✅ Correos V6 enviados: ${bookingData.id}`);

    } catch (e) {
        console.error("❌ Error enviando correos:", e);
    }
}


// --- 3. HANDLER PRINCIPAL (Sin cambios en lógica) ---
exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    let body;
    try { body = JSON.parse(event.body); if (typeof body === 'string') body = JSON.parse(body); } catch (e) { throw new Error('JSON inválido.'); }
    const operations = Array.isArray(body) ? body : [body];

    const hasAdminToken = await validateGoogleToken(event);
    let services;

    if (hasAdminToken) {
        services = await getServices();
    } else {
        const allowedPublicSheets = ['Bookings', 'BookingsDetails', 'BlockedDates'];
        const isSafePublicRequest = operations.every(op => op.action === 'add' && allowedPublicSheets.includes(op.sheet));
        if (!isSafePublicRequest) return { statusCode: 401, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'No autorizado.' }) };
        services = await getServices(true);
    }

    const { doc, drive } = services;

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
        
        if (sheetName === 'Bookings') {
            const bookingsToAdd = sheetOps.filter(op => op.action === 'add' || op.action === 'update');
            if (bookingsToAdd.length > 0) {
                const blockedSheet = doc.sheetsByTitle['BlockedDates'];
                if (blockedSheet) {
                    await blockedSheet.loadHeaderRow();
                    const blockedRows = await blockedSheet.getRows();
                    const hStart = getRealHeader(blockedSheet, 'startDate'); const hEnd = getRealHeader(blockedSheet, 'endDate'); const hItem = getRealHeader(blockedSheet, 'itemId'); const hBook = getRealHeader(blockedSheet, 'bookingId');
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

        for (const op of adds) {
            if (!op.data.id && !['Settings', 'About'].includes(sheetName)) { op.data.id = `${sheetName.toLowerCase().slice(0, 5)}_${Date.now()}_${Math.floor(Math.random()*1000)}`; }
            const rowData = {};
            Object.keys(op.data).forEach(k => { const h = getRealHeader(sheet, k); if (h) rowData[h] = op.data[k]; });
            await sheet.addRow(rowData); 
            
            // ENVÍO DE CORREO PRO (V6)
            if (sheetName === 'Bookings' && !hasAdminToken) {
                await sendReservationEmails(doc, op.data, operations);
            }
        }
        
        // (Resto de la lógica updates/deletes se mantiene igual)
        if (updates.length > 0) {
            const rows = await sheet.getRows(); 
            for (const op of updates) {
                const criteriaKey = Object.keys(op.criteria)[0]; const criteriaVal = String(op.criteria[criteriaKey]).trim(); const realHeaderKey = getRealHeader(sheet, criteriaKey); if (!realHeaderKey && ['Settings', 'About'].includes(sheetName)) { await sheet.addRow({ ...op.criteria, ...op.data }); continue; } const targetRow = rows.find(r => String(r.get(realHeaderKey)).trim() === criteriaVal);
                if (targetRow) {
                    if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) { const titleKey = sheetName === 'RentalItems' ? 'name' : 'title'; const newTitle = getDataVal(op.data, titleKey); if (newTitle) { const hTitle = getRealHeader(sheet, titleKey); const hFolder = getRealHeader(sheet, 'driveFolderId'); const currentTitle = hTitle ? targetRow.get(hTitle) : ''; const folderId = hFolder ? targetRow.get(hFolder) : null; if (folderId && currentTitle !== newTitle) { try { await drive.files.update({ fileId: folderId, requestBody: { name: newTitle }, supportsAllDrives: true }); } catch(e){} } } }
                    if ((sheetName === 'ProjectImages' || sheetName === 'RentalItemImages') && String(op.data.isCover).toLowerCase() === 'si') { const pKey = sheetName === 'ProjectImages' ? 'projectId' : 'itemId'; const pHeader = getRealHeader(sheet, pKey); const cHeader = getRealHeader(sheet, 'isCover'); if (pHeader && cHeader) { const currentPId = targetRow.get(pHeader); for (const r of rows) { if (r !== targetRow && String(r.get(pHeader)) === String(currentPId) && String(r.get(cHeader)).toLowerCase() === 'si') { r.set(cHeader, 'No'); await r.save(); } } } }
                    let hasChanges = false; Object.keys(op.data).forEach(key => { const h = getRealHeader(sheet, key); if (h) { targetRow.set(h, op.data[key]); hasChanges = true; } }); if (hasChanges) await targetRow.save();
                }
            }
        }
        if (deletes.length > 0) {
            const currentRows = await sheet.getRows(); for (const op of deletes) { const criteriaKey = Object.keys(op.criteria)[0]; const criteriaVal = String(op.criteria[criteriaKey]).trim(); const realKeyHeader = getRealHeader(sheet, criteriaKey); if (!realKeyHeader) continue; if (sheetName === 'RentalCategories') { /*Validation*/ } const row = currentRows.find(r => String(r.get(realKeyHeader)).trim() === criteriaVal); if (row) { let fileId = getDataVal(op.data, 'fileId'); if (!fileId) { const hFile = getRealHeader(sheet, 'fileId'); if (hFile) fileId = row.get(hFile); } if (fileId) { try { await drive.files.update({ fileId: fileId, requestBody: { trashed: true }, supportsAllDrives: true }); } catch(e){} } if (['Projects', 'RentalItems', 'Services'].includes(sheetName)) { const hFolder = getRealHeader(sheet, 'driveFolderId'); const folderId = hFolder ? row.get(hFolder) : null; if (folderId) { try { await drive.files.update({ fileId: folderId, requestBody: { trashed: true }, supportsAllDrives: true }); } catch(e){} } if (sheetName === 'Projects') await deleteChildRows(doc, 'ProjectImages', 'projectId', criteriaVal); if (sheetName === 'RentalItems') { await deleteChildRows(doc, 'RentalItemImages', 'itemId', criteriaVal); await deleteChildRows(doc, 'BlockedDates', 'itemId', criteriaVal); await deleteChildRows(doc, 'Bookings', 'itemId', criteriaVal); } if (sheetName === 'Services') { await deleteChildRows(doc, 'ServiceImages', 'serviceId', criteriaVal); await deleteChildRows(doc, 'ServiceContentBlocks', 'serviceId', criteriaVal); } } await row.delete(); } }
        }
    }
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ message: 'OK' }) };
  } catch (error) { console.error('Error:', error); return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: error.message }) }; }
};
