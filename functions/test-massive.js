const nodemailer = require('nodemailer');

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const body = JSON.parse(event.body);
        const { driveLink, cdnLink, imgbbLink, clientEmail } = body;

        // Usamos las credenciales que YA existen en Netlify
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });

        // HTML del Correo de Prueba
        const htmlContent = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #333; color: #fff; background: #000;">
                <div style="padding: 20px; text-align: center; border-bottom: 1px solid #444;">
                    <h1 style="margin:0;">🧪 Prueba Masiva de Imágenes</h1>
                </div>
                
                <div style="padding: 20px;">
                    <p style="color: #ccc; text-align: center;">Revisa cuál de estas 3 imágenes carga correctamente en tu dispositivo.</p>

                    <div style="margin-bottom: 30px; background: #111; padding: 10px; border-radius: 8px;">
                        <h3 style="color: #fff; border-bottom: 1px solid #333; padding-bottom: 5px;">1. Drive Original</h3>
                        <p style="font-size: 10px; color: #777; word-break: break-all;">${driveLink}</p>
                        <img src="${driveLink}" style="width: 100%; height: auto; display: block; border-radius: 4px; background: #222; min-height: 100px;" alt="Fallo Drive">
                    </div>

                    <div style="margin-bottom: 30px; background: #111; padding: 10px; border-radius: 8px;">
                        <h3 style="color: #ffff00; border-bottom: 1px solid #333; padding-bottom: 5px;">2. Google CDN (LH3)</h3>
                        <p style="font-size: 10px; color: #777; word-break: break-all;">${cdnLink}</p>
                        <img src="https://wsrv.nl/?url=${encodeURIComponent(cdnLink)}&w=600&output=jpg" style="width: 100%; height: auto; display: block; border-radius: 4px; background: #222; min-height: 100px;" alt="Fallo CDN">
                    </div>

                    <div style="margin-bottom: 30px; background: #111; padding: 10px; border-radius: 8px;">
                        <h3 style="color: #00ff00; border-bottom: 1px solid #333; padding-bottom: 5px;">3. ImgBB (Hosting Externo)</h3>
                        <p style="font-size: 10px; color: #777; word-break: break-all;">${imgbbLink}</p>
                        <img src="${imgbbLink}" style="width: 100%; height: auto; display: block; border-radius: 4px; background: #222; min-height: 100px;" alt="Fallo ImgBB">
                    </div>

                </div>
                <div style="padding: 15px; text-align: center; color: #555; font-size: 12px; border-top: 1px solid #333;">
                    Prueba generada automáticamente.
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: `"Test Lab" <${process.env.SMTP_USER}>`,
            to: clientEmail,
            subject: "🧪 Resultados: Prueba Masiva de Imágenes",
            html: htmlContent
        });

        return { statusCode: 200, body: JSON.stringify({ message: 'Enviado' }) };

    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
