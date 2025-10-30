// functions/create-booking.js
// FUNCIÓN PÚBLICA (No requiere autenticación de admin)
// Recibe los datos del formulario de reserva del sitio público y los guarda en la hoja "Bookings".

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// Helper de autenticación (CUENTA DE SERVICIO)
async function getDoc() {
  const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
  await doc.loadInfo();
  return doc;
}

exports.handler = async (event, context) => {
  // 1. Solo permitir POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const data = JSON.parse(event.body);

    // 2. Validación simple de datos (Ajustar según sea necesario)
    if (!data.itemId || !data.startDate || !data.endDate || !data.customerName || !data.customerEmail) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Faltan campos requeridos.' }) };
    }

    // 3. Conectar a Google Sheets
    const doc = await getDoc();
    const sheet = doc.sheetsByTitle['Bookings'];
    if (!sheet) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Hoja "Bookings" no encontrada.' }) };
    }
    
    // 4. Preparar la nueva fila
    const newBooking = {
      id: `res_${Date.now()}`,
      bookingTimestamp: new Date().toISOString(),
      status: 'Pendiente', // Estado inicial según La Guía
      itemId: data.itemId,
      itemName: data.itemName,
      startDate: data.startDate,
      endDate: data.endDate,
      totalDays: data.totalDays,
      totalPrice: data.totalPrice,
      customerName: data.customerName,
      customerEmail: data.customerEmail,
      customerPhone: data.customerPhone || ''
    };

    // 5. Añadir la fila
    await sheet.addRow(newBooking);

    // 6. Devolver éxito
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ message: 'Reserva creada exitosamente.', bookingId: newBooking.id }),
    };

  } catch (error) {
    console.error('Error en create-booking:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error interno al procesar la reserva.', details: error.message }),
    };
  }
};

