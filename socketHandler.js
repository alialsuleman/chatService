const { validateUser } = require('./authService');
const db = require('./db');
const axios = require('axios');

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
                token: token
            };
            next();
        } else {
            next(new Error("Authentication error: Invalid Token"));
        }
    });

    io.on('connection', (socket) => {
        const userId = socket.user.id;
        console.log(`✅ User Connected: ${socket.user.name} (ID: ${userId})`);

        // تخزين المحادثات النشطة للمستخدم
        socket.activeConversations = new Set();

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

        // حدث دخول المستخدم إلى محادثة معينة
        socket.on('join_conversation', (data) => {
            const { conversation_id, other_user_id } = data;

            if (conversation_id) {
                socket.activeConversations.add(conversation_id);
                console.log(`👤 User ${userId} joined conversation ${conversation_id}`);
            }

            // تخزين ID المستخدم الآخر
            if (other_user_id) {
                socket.currentConversationWith = other_user_id;
            }
        });

        // حدث خروج المستخدم من محادثة معينة
        socket.on('leave_conversation', (data) => {
            const { conversation_id } = data;

            if (conversation_id) {
                socket.activeConversations.delete(conversation_id);
                console.log(`👋 User ${userId} left conversation ${conversation_id}`);
            }

            // مسح المحادثة الحالية
            if (socket.currentConversationWith) {
                socket.currentConversationWith = null;
            }
        });

        // دالة للحصول على معلومات المستخدم الشريك
        const getPartnerInfo = async (partnerId) => {
            try {
                const [rows] = await db.execute(
                    `SELECT id, firstname, lastname, image_path 
                        FROM antelaka._user 
                        WHERE id = ?`,
                    [partnerId]
                );
                if (rows.length > 0) {
                    return {
                        id: rows[0].id,
                        firstname: rows[0].firstname,
                        lastname: rows[0].lastname,
                        imagePath: rows[0].image_path || null
                    };
                }
                return null;
            } catch (err) {
                console.error('Error getting partner info:', err);
                return null;
            }
        };

        // دالة لحساب عدد الرسائل غير المقروءة
        const getUnreadCount = async (userId, partnerId) => {
            try {
                const [rows] = await db.execute(
                    `SELECT COUNT(*) as count FROM messages 
                     WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
                    [partnerId, userId]
                );
                return rows[0].count;
            } catch (err) {
                console.error('Error getting unread count:', err);
                return 0;
            }
        };

        // دالة لإرسال الإشعار إلى Spring Boot مع تفاصيل كاملة

        const sendNotificationToSpring = async (senderId, receiverId, messageId, uuid, content, createdAt) => {
            console.log("token is :", socket.user?.token);
            console.log("user is :", socket.user);

            try {
                const partnerInfo = await getPartnerInfo(senderId);
                const unreadCount = await getUnreadCount(receiverId, senderId);

                const notificationPayload = {
                    id: messageId,
                    uuid: uuid,
                    sender_id: senderId,
                    receiver_id: receiverId,
                    content: content,
                    is_read: 0,
                    created_at: createdAt,
                    is_delivered: 0,
                    unread_count: unreadCount,
                    partner_id: senderId,
                    isMine: false,
                    partner_info: partnerInfo
                };

                console.log("📦 Payload being sent:", JSON.stringify(notificationPayload, null, 2));

                const response = await axios.post(
                    `${process.env.SPRING_BOOT_API_URL}/notifications/create`,
                    notificationPayload,
                    {
                        headers: {
                            Authorization: `Bearer ${socket.user.token}`,
                            "Content-Type": "application/json"
                        }
                    }
                );

                console.log("✅ Response from Spring:", response.data);

                return response.data;

            } catch (error) {

                console.error("❌ ERROR sending notification");

                // 🟡 أهم جزء: كل التفاصيل
                if (error.response) {
                    console.error("📥 Response status:", error.response.status);
                    console.error("📥 Response headers:", error.response.headers);
                    console.error("📥 Response data:", error.response.data); // 🔥 هذا الأهم
                }

                if (error.request) {
                    console.error("📡 No response received. Request was:", error.request);
                }

                console.error("🧠 Error message:", error.message);
                console.error("🧠 Full error object:", error);

                return null;
            }
        };

        // دالة للتحقق مما إذا كان المستخدم في نفس المحادثة
        const checkUserInSameConversation = async (senderId, receiverId) => {
            try {
                // الحصول على جميع Sockets للمستقبل
                const receiverSockets = await io.in(`user_${receiverId}`).fetchSockets();

                // التحقق مما إذا كان أي من Sockets المستقبل في نفس المحادثة مع المرسل
                for (const receiverSocket of receiverSockets) {
                    // إذا كان المستقبل في محادثة نشطة مع المرسل
                    if (receiverSocket.activeConversations &&
                        receiverSocket.activeConversations.size > 0 &&
                        receiverSocket.currentConversationWith === senderId) {
                        return true;
                    }
                }
                return false;
            } catch (err) {
                console.error('Error checking conversation:', err);
                return false;
            }
        };

        // استقبال رسالة
        socket.on('send_message', async (data) => {
            const { receiver_id, content, uuid, conversation_id } = data;
            const sender_id = socket.user.id;
            const token = socket.user.token;

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
                    // التحقق مما إذا كان المستقبل في نفس المحادثة
                    const isInSameConversation = await checkUserInSameConversation(sender_id, receiver_id);

                    if (isInSameConversation) {
                        // المستخدم في نفس المحادثة - لا نرسل إشعار
                        console.log(`💬 User ${receiver_id} is in same conversation - no notification sent`);

                        // تحديث حالة التسليم
                        await db.execute(
                            `UPDATE messages SET is_delivered = 1 WHERE id = ?`,
                            [result.insertId]
                        );

                        messagePayload.is_delivered = 1;

                        // إرسال الرسالة فقط
                        io.to(`user_${receiver_id}`).emit('receive_message', messagePayload);

                        socket.emit('message_sent', {
                            uuid: uuid,
                            id: result.insertId,
                            is_delivered: 1,
                            status: 'delivered',
                            timestamp: messagePayload.created_at
                        });
                    } else {
                        // المستخدم متصل ولكن ليس في نفس المحادثة
                        console.log(`📱 User ${receiver_id} is online but not in conversation - sending full notification`);

                        // تحديث حالة التسليم
                        await db.execute(
                            `UPDATE messages SET is_delivered = 1 WHERE id = ?`,
                            [result.insertId]
                        );

                        messagePayload.is_delivered = 1;

                        // إرسال الرسالة
                        io.to(`user_${receiver_id}`).emit('receive_message', messagePayload);

                        socket.emit('message_sent', {
                            uuid: uuid,
                            id: result.insertId,
                            is_delivered: 1,
                            status: 'delivered',
                            timestamp: messagePayload.created_at
                        });

                        // إرسال إشعار كامل بالتفاصيل
                        await sendNotificationToSpring(
                            sender_id,
                            receiver_id,
                            result.insertId,
                            uuid,
                            content,
                            timestamp.toISOString()
                        );
                    }
                } else {
                    // المستقبل غير متصل - نرسل إشعار
                    console.log(`📱 User ${receiver_id} is offline - sending full notification`);

                    socket.emit('message_sent', {
                        uuid: uuid,
                        id: result.insertId,
                        is_delivered: 0,
                        status: 'pending',
                        timestamp: messagePayload.created_at,
                        note: "User is offline"
                    });

                    // إرسال إشعار كامل بالتفاصيل
                    try {
                        await sendNotificationToSpring(
                            sender_id,
                            receiver_id,
                            result.insertId,
                            uuid,
                            content,
                            timestamp.toISOString()
                        );
                    } catch (notifyError) {
                        console.error("❌ Failed to send notification (but message saved):", notifyError.message);
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
            // تنظيف البيانات
            socket.activeConversations.clear();
            socket.currentConversationWith = null;
        });
    });
};