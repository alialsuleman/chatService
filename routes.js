const express = require('express');
const router = express.Router();
const db = require('./db');
const axios = require('axios'); // تأكد من تثبيت axios
const { validateUser } = require('./authService');

// دالة مساعدة لجلب بيانات المستخدم من الـ API الخارجي
const fetchUserData = async (id, token) => {



    try {
        // التأكد من أن الرابط مبني بشكل صحيح
        const baseUrl = process.env.USER_DATA_API.endsWith('/')
            ? process.env.USER_DATA_API
            : `${process.env.USER_DATA_API}/`;
        console.log(`${baseUrl}${id}`);

        const response = await axios.get(`${baseUrl}${id}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });


        if (response.data && response.data.success) {
            return {
                id: response.data.data.id,
                firstname: response.data.data.firstname,
                lastname: response.data.data.lastname,
                imagePath: response.data.data.imagePath
            };
        }
        return null;
    } catch (error) {
        // طباعة الخطأ لمعرفة السبب (هل هو 404 أم 500 أم مشكلة اتصال؟)
        console.error(`Auth API Error for ID ${id}:`, error.message);
        return null;
    }
};

const authMiddleware = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });

    const user = await validateUser(token);
    if (!user) return res.status(403).json({ error: 'Invalid token' });

    req.user = user;
    next();
};

// 1. جلب سجل المحادثة - نسخة الـ Pagination المصححة
router.get('/history/:contactId', authMiddleware, async (req, res) => {
    const myId = req.user.id;
    const contactId = req.params.contactId;

    // الحصول على القيم من الـ Query String وتأكيد أنها أرقام
    // إذا أرسل المستخدم page=0 سنعتبرها 1
    const page = Math.max(1, (parseInt(req.query.page) + 1) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 10);
    const offset = (page - 1) * limit;

    try {
        // تحديث الرسائل المستلمة لتصبح مقروءة
        await db.query(
            `UPDATE messages SET is_read = 1 
             WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
            [contactId, myId]
        );

        // جلب الرسائل باستخدام db.query لحل مشكلة LIMIT/OFFSET
        const [rows] = await db.query(
            `SELECT * FROM messages 
             WHERE (sender_id = ? AND receiver_id = ?) 
                OR (sender_id = ? AND receiver_id = ?) 
             ORDER BY created_at DESC 
             LIMIT ? OFFSET ?`,
            [myId, contactId, contactId, myId, limit, offset]
        );

        // إضافة حالة التسليم والبيانات الإضافية
        const enhancedRows = rows.map(row => {
            let delivery_status = 'received';
            if (row.sender_id === myId) {
                delivery_status = row.is_delivered === 0 ? 'pending' : 'delivered';
            }

            let is_read_display = row.is_read === 1 ? 'Read' : 'New';

            if (row.sender_id === myId) {
                if (row.is_delivered === 0) {
                    is_read_display = 'Pending'; // أو 'Sending...'
                } else if (row.is_read === 1) {
                    is_read_display = 'Read';    // تعادل الـ ✓✓ الزرقاء في واتساب
                } else {
                    is_read_display = 'Sent';    // تم الإرسال ولكن لم يقرأ بعد
                }
            }

            return {
                ...row,
                delivery_status: delivery_status,
                status_display: is_read_display
            };
        });

        // ملاحظة: في الـ History نفضل عرض الرسائل من الأقدم للأحدث 
        // لكننا جلبناها DESC للحصول على آخر 10 رسائل، لذا سنعكس المصفوفة
        res.json({
            success: true,
            meta: {
                current_page: page,
                limit: limit,
                results_count: enhancedRows.length
            },
            data: enhancedRows.reverse()
        });
    } catch (err) {
        console.error('Error in /history:', err);
        res.status(500).json({ error: err.message });
    }
});
router.get('/inbox', authMiddleware, async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });


    const myId = req.user.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 10;
    const offset = (page - 1) * limit;

    try {
        const sql = `
            SELECT m1.*, 
            (
                SELECT COUNT(*) 
                FROM messages 
                WHERE sender_id = (CASE WHEN m1.sender_id = ? THEN m1.receiver_id ELSE m1.sender_id END) 
                  AND receiver_id = ? 
                  AND is_read = 0
            ) as unread_count,
            CASE WHEN m1.sender_id = ? THEN m1.receiver_id ELSE m1.sender_id END as partner_id
            FROM messages m1
            INNER JOIN (
                SELECT MAX(id) as max_id 
                FROM messages 
                WHERE sender_id = ? OR receiver_id = ? 
                GROUP BY CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END
            ) m2 ON m1.id = m2.max_id
            ORDER BY m1.created_at DESC 
            LIMIT ? OFFSET ?`;

        const params = [myId, myId, myId, myId, myId, myId, limit, offset];
        const [rows] = await db.query(sql, params);

        // استخدام Promise.all لجلب البيانات
        const conversationsWithUsers = await Promise.all(rows.map(async (conv) => {
            const userData = await fetchUserData(conv.partner_id, token);

            return {
                ...conv,
                // إذا كان userData موجوداً، نعرض البيانات، وإلا نضع كائن "مستخدم غير معروف"
                partner_info: userData ? {
                    id: userData.id,
                    firstname: userData.firstname,
                    lastname: userData.lastname,
                    imagePath: userData.imagePath,
                    bio: userData.bio,
                    email: userData.email,
                    whatsappLink: userData.whatsappLink,
                    facebookLink: userData.facebookLink,
                    telegramLink: userData.telegramLink,
                    linkedinLink: userData.linkedinLink
                } : {
                    id: conv.partner_id,
                    firstname: "User",
                    lastname: String(conv.partner_id),
                    imagePath: null
                }
            };
        }));

        res.json({
            success: true,
            meta: {
                current_page: page,
                per_page: limit,
                count: rows.length
            },
            data: conversationsWithUsers
        });

    } catch (err) {
        console.error('Error in /inbox:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});
module.exports = router;