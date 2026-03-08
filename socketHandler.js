const { validateUser } = require('./authService');
const db = require('./db');
const axios = require('axios'); // إضافة axios

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
                name: user.firstname,
                token: token // تخزين التوكن لاستخدامه لاحقاً
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

        const sendPendingMessages = async () => {
            try {
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
                        uuid: message.uuid,
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

        // دالة للتحقق من وجود رسائل غير مقروءة خلال آخر 10 دقائق
        const hasRecentUnreadMessages = async (receiverId) => {
            try {
                const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
                const [rows] = await db.execute(
                    `SELECT COUNT(*) as count FROM messages 
                     WHERE receiver_id = ? AND is_read = 0 AND created_at >= ?`,
                    [receiverId, tenMinutesAgo]
                );
                return rows[0].count > 0;
            } catch (err) {
                console.error('Error checking recent unread messages:', err);
                return false; // في حالة الخطأ، نفضل عدم إرسال إشعار
            }
        };

        // دالة لإرسال الإشعار إلى Spring Boot
        // دالة لإرسال الإشعار إلى Spring Boot
        const sendNotificationToSpring = async (senderId, receiverId, messageContent, token) => {
            try {
                const response = await axios.post(
                    `${process.env.SPRING_BOOT_API_URL}/notifications/create`,
                    {
                        senderId: senderId,      // ✅ إضافة id المرسل
                        receiverId: receiverId,  // ✅ إضافة id المستقبل
                        text: messageContent,
                        timestamp: new Date().toISOString()
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );
                console.log(`📱 Notification sent to Spring Boot: From user ${senderId} To user ${receiverId}`);
                return response.data;
            } catch (error) {
                console.error(`❌ Failed to send notification to Spring Boot:`, error.message);
                return null;
            }
        };

        // --- استقبال رسالة ---
        socket.on('send_message', async (data) => {
            const { receiver_id, content, uuid } = data;
            const sender_id = socket.user.id;
            const token = socket.user.token; // التوكن المخزن

            if (!receiver_id || !content || !uuid) {
                return socket.emit('error', {
                    message: 'Missing data',
                    uuid: uuid || null
                });
            }

            try {
                // الحفظ في قاعدة البيانات
                const timestamp = new Date();
                const [result] = await db.execute(
                    `INSERT INTO messages (sender_id, receiver_id, content, uuid, is_delivered, created_at) 
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [sender_id, receiver_id, content, uuid, 0, timestamp]
                );

                const messagePayload = {
                    id: result.insertId,
                    uuid: uuid,
                    sender_id: sender_id,
                    receiver_id: receiver_id,
                    content: content,
                    created_at: timestamp.toISOString().replace('T', ' ').substring(0, 19),
                    is_read: false,
                    is_delivered: 0
                };

                // التحقق مما إذا كان المستقبل متصلاً
                const receiverSockets = await io.in(`user_${receiver_id}`).fetchSockets();

                if (receiverSockets.length > 0) {
                    // المستقبل متصل
                    await db.execute(
                        `UPDATE messages SET is_delivered = 1 WHERE id = ?`,
                        [result.insertId]
                    );

                    messagePayload.is_delivered = 1;

                    // إرسال للمستقبل
                    io.to(`user_${receiver_id}`).emit('receive_message', messagePayload);

                    // إرسال تأكيد للمرسل
                    socket.emit('message_sent', {
                        uuid: uuid,
                        id: result.insertId,
                        is_delivered: 1,
                        status: 'delivered',
                        timestamp: messagePayload.created_at
                    });

                    // المستقبل متصل، لا حاجة لإرسال إشعار خارجي
                } else {
                    // المستقبل غير متصل
                    socket.emit('message_sent', {
                        uuid: uuid,
                        id: result.insertId,
                        is_delivered: 0,
                        status: 'pending',
                        timestamp: messagePayload.created_at,
                        note: "Any"
                    });

                    // التحقق من عدم وجود رسائل غير مقروءة حديثة لنفس المستقبل
                    const recentUnread = await hasRecentUnreadMessages(receiver_id);

                    if (!recentUnread) {
                        // لا توجد رسائل غير مقروءة خلال آخر 10 دقائق → أرسل إشعار إلى Spring Boot
                        await sendNotificationToSpring(
                            sender_id, receiver_id, content, token);
                    } else {
                        console.log(`⏳ Skipping notification for user ${receiver_id}: recent unread messages exist`);
                    }
                }

            } catch (err) {
                console.error("❌ Error saving message:", err);
                socket.emit('error', {
                    message: 'Failed to send message',
                    uuid: uuid
                });
            }
        });

        socket.on('disconnect', () => {
            console.log(`User Disconnected: ${userId}`);
        });
    });
};