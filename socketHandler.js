// استقبال رسالة
socket.on('send_message', async (data) => {
    const { receiver_id, content, uuid } = data;
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
            // المستقبل متصل
            await db.execute(
                `UPDATE messages SET is_delivered = 1 WHERE id = ?`,
                [result.insertId]
            );

            messagePayload.is_delivered = 1;

            io.to(`user_${receiver_id}`).emit('receive_message', messagePayload);

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
                note: "User is offline"
            });

            // التحقق من عدم وجود رسائل غير مقروءة حديثة لنفس المستقبل
            const recentUnread = await hasRecentUnreadMessages(receiver_id);

            if (!recentUnread) {
                try { // 🔴 🔴 🔴 أضف try/catch هنا
                    await sendNotificationToSpring(
                        sender_id, receiver_id, content, token);
                } catch (notifyError) {
                    console.error("❌ Failed to send notification (but message saved):", notifyError.message);
                    // لا تقم بإعادة رمي الخطأ - فقط سجله واستمر
                }
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