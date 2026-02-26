const { validateUser } = require('./authService');
const db = require('./db');

module.exports = (io) => {

    io.use(async (socket, next) => {
        const token = socket.handshake.auth.token;

        if (!token) {
            return next(new Error("Authentication error: No token provided"));
        }

        const user = await validateUser(token);

        if (user) {
            socket.user = {
                id: user.id,
                name: user.firstname
            };
            next();
        } else {
            next(new Error("Authentication error: Invalid Token"));
        }
    });

    io.on('connection', (socket) => {
        const userId = socket.user.id;
        console.log(`✅ User Connected: ${socket.user.name} (ID: ${userId})`);

        // إرسال معلومات المستخدم إلى العميل
        socket.emit('user_info', {
            id: userId,
            name: socket.user.name
        });

        // الانضمام للغرفة
        socket.join(`user_${userId}`);

        // إرسال الرسائل المعلقة لهذا المستخدم عند الاتصال
        const sendPendingMessages = async () => {
            try {
                // استخدام pagination للرسائل المعلقة لتجنب إرسال عدد كبير دفعة واحدة
                const [pendingMessages] = await db.execute(
                    `SELECT * FROM messages 
                     WHERE receiver_id = ? AND is_delivered = 0 
                     ORDER BY created_at ASC
                     LIMIT 100`,
                    [userId]
                );

                for (const message of pendingMessages) {
                    socket.emit('receive_message', {
                        id: message.id,
                        uuid: message.uuid, // إضافة uuid
                        sender_id: message.sender_id,
                        receiver_id: message.receiver_id,
                        content: message.content,
                        created_at: message.created_at,
                        is_read: false,
                        is_delivered: true
                    });

                    await db.execute(
                        `UPDATE messages SET is_delivered = 1 WHERE id = ?`,
                        [message.id]
                    );
                }

                if (pendingMessages.length > 0) {
                    console.log(`📨 Sent ${pendingMessages.length} pending messages to user ${userId}`);
                    socket.emit('pending_delivered', { count: pendingMessages.length });
                }
            } catch (err) {
                console.error("❌ Error sending pending messages:", err);
            }
        };

        sendPendingMessages();

        // --- استقبال رسالة ---
        socket.on('send_message', async (data) => {
            const { receiver_id, content, uuid } = data; // استقبال uuid من العميل
            const sender_id = socket.user.id;

            if (!receiver_id || !content || !uuid) { // التحقق من وجود uuid
                return socket.emit('error', {
                    message: 'Missing data',
                    uuid: uuid || null // إرجاع uuid إذا كان موجوداً
                });
            }

            try {
                // الحفظ في قاعدة البيانات مع timestamp دقيق
                const timestamp = new Date();
                const [result] = await db.execute(
                    `INSERT INTO messages (sender_id, receiver_id, content, uuid, is_delivered, created_at) 
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [sender_id, receiver_id, content, uuid, 0, timestamp]
                );

                const messagePayload = {
                    id: result.insertId,
                    uuid: uuid, // إضافة uuid
                    sender_id: sender_id,
                    receiver_id: receiver_id,
                    content: content,
                    created_at: timestamp.toISOString().replace('T', ' ').substring(0, 19),
                    is_read: false,
                    is_delivered: 0
                };

                // التحقق مما إذا كان المستقبل متصلًا
                const receiverSockets = await io.in(`user_${receiver_id}`).fetchSockets();

                if (receiverSockets.length > 0) {
                    // المستقبل متصل - تحديث وإرسال
                    await db.execute(
                        `UPDATE messages SET is_delivered = 1 WHERE id = ?`,
                        [result.insertId]
                    );

                    messagePayload.is_delivered = 1;

                    // إرسال للمستقبل
                    io.to(`user_${receiver_id}`).emit('receive_message', messagePayload);

                    // إرسال تأكيد للمرسل مع uuid
                    socket.emit('message_sent', {
                        uuid: uuid,
                        id: result.insertId,
                        is_delivered: 1,
                        status: 'delivered',
                        timestamp: messagePayload.created_at
                    });
                } else {
                    // المستقبل غير متصل
                    socket.emit('message_sent', {
                        uuid: uuid,
                        id: result.insertId,
                        is_delivered: 0,
                        status: 'pending',
                        timestamp: messagePayload.created_at,
                        note: 'سوف تصل عندما يتصل المستخدم'
                    });
                }

            } catch (err) {
                console.error("❌ Error saving message:", err);
                socket.emit('error', {
                    message: 'Failed to send message',
                    uuid: uuid // إرجاع uuid عند حدوث خطأ
                });
            }
        });

        socket.on('disconnect', () => {
            console.log(`User Disconnected: ${userId}`);
        });
    });
};