const express = require('express');
const router = express.Router();
const db = require('./db');
const axios = require('axios'); // تأكد من تثبيت axios
const { validateUser } = require('./authService');

// دالة مساعدة لتنسيق الاستجابة
const formatResponse = (success, message, data = null, errors = [], status = 200) => {
    return {
        success,
        message,
        data,
        errors: Array.isArray(errors) ? errors : [errors],
        timestamp: new Date().toISOString(),
        status
    };
};

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
    if (!token) {
        return res.status(401).json(formatResponse(false, 'No token provided', null, ['Authentication token is missing'], 401));
    }

    const user = await validateUser(token);
    if (!user) {
        return res.status(403).json(formatResponse(false, 'Invalid token', null, ['The provided token is invalid'], 403));
    }

    req.user = user;
    next();
};

// 1. جلب سجل المحادثة - نسخة Cursor Pagination
router.get('/history/:contactId', authMiddleware, async (req, res) => {
    const myId = req.user.id;
    const contactId = req.params.contactId;

    // قراءة وتجهيز المعاملات
    const limit = Math.min(parseInt(req.query.limit) || 10, 50); // حد أقصى 50
    const cursor = parseInt(req.query.cursor); // قد يكون undefined أو NaN

    try {
        // تحديث الرسائل المستلمة لتصبح مقروءة
        await db.query(
            `UPDATE messages SET is_read = 1 
             WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
            [contactId, myId]
        );

        // بناء الاستعلام الأساسي
        let sql = `
            SELECT * FROM messages 
            WHERE (sender_id = ? AND receiver_id = ?) 
               OR (sender_id = ? AND receiver_id = ?)
        `;
        const params = [myId, contactId, contactId, myId];

        // إضافة شرط cursor إذا وُجد (جلب الرسائل الأقدم من الـ cursor)
        if (cursor && !isNaN(cursor)) {
            sql += ` AND id < ?`;
            params.push(cursor);
        }

        // ترتيب تنازلي وجلب عدد أكبر بواحد لمعرفة وجود صفحة تالية
        sql += ` ORDER BY id DESC LIMIT ?`;
        params.push(limit + 1);

        // تنفيذ الاستعلام
        const [rows] = await db.query(sql, params);

        // تحديد ما إذا كانت هناك صفحة تالية وحساب next_cursor
        let nextCursor = null;
        let data = rows;

        if (rows.length > limit) {
            // يوجد صفحة تالية: نأخذ أول limit عنصر فقط
            data = rows.slice(0, limit);
            // آخر عنصر في الصفحة الحالية هو cursor للصفحة التالية
            nextCursor = data[data.length - 1].id;
        }

        // إضافة حقل isMine لكل رسالة
        const enhancedRows = data.map(row => ({
            ...row,
            isMine: row.sender_id === myId
        }));

        // الرد
        res.json(formatResponse(
            true,
            'Chat history retrieved successfully',
            {
                meta: {
                    limit: limit,
                    results_count: enhancedRows.length,
                    next_cursor: nextCursor,
                    sql,
                    params
                },
                data: enhancedRows // ترسل بترتيب تنازلي (الأحدث أولاً)
            },
            [],
            200
        ));
    } catch (err) {
        console.error('Error in /history:', err);
        res.status(500).json(formatResponse(false, 'Failed to retrieve chat history', null, [err.message], 500));
    }
});


router.get('/inbox', authMiddleware, async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json(formatResponse(false, 'No token provided', null, ['Authentication token is missing'], 401));
    }

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
                // إضافة حقل isMine للتحقق مما إذا كانت آخر رسالة من المستخدم الحالي
                isMine: conv.sender_id === myId,
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

        res.json(formatResponse(
            true,
            'Inbox retrieved successfully',
            {
                meta: {
                    current_page: page,
                    per_page: limit,
                    count: rows.length
                },
                data: conversationsWithUsers
            },
            [],
            200
        ));

    } catch (err) {
        console.error('Error in /inbox:', err);
        res.status(500).json(formatResponse(false, 'Failed to retrieve inbox', null, [err.message], 500));
    }
});
// 3. البحث في جهات الاتصال السابقة (المستخدمين الذين تواصلت معهم)
router.get('/search-contacts', authMiddleware, async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json(formatResponse(false, 'No token provided', null, ['Authentication token is missing'], 401));
    }

    const myId = req.user.id;
    const searchTerm = req.query.q || '';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 20); // حد أقصى 20 نتيجة
    const offset = (page - 1) * limit;

    // التحقق من وجود مصطلح بحث
    if (!searchTerm.trim()) {
        return res.status(400).json(formatResponse(false, 'Search term is required', null, ['Please provide a search query'], 400));
    }

    try {
        // جلب جميع المستخدمين الذين تواصلت معهم مع آخر رسالة لكل منهم
        const contactsSql = `
            SELECT DISTINCT 
                CASE 
                    WHEN sender_id = ? THEN receiver_id 
                    ELSE sender_id 
                END as contact_id,
                MAX(created_at) as last_message_date
            FROM messages 
            WHERE sender_id = ? OR receiver_id = ?
            GROUP BY contact_id
            ORDER BY last_message_date DESC
        `;

        const [contactRows] = await db.query(contactsSql, [myId, myId, myId]);

        if (contactRows.length === 0) {
            return res.json(formatResponse(
                true,
                'No contacts found',
                {
                    meta: {
                        current_page: page,
                        per_page: limit,
                        total_count: 0,
                        total_pages: 0
                    },
                    data: []
                },
                [],
                200
            ));
        }

        // جلب بيانات كل contact من الـ API مع تطبيق البحث
        const contactsPromises = contactRows.map(async (contact) => {
            const userData = await fetchUserData(contact.contact_id, token);
            return {
                ...userData,
                last_message_date: contact.last_message_date
            };
        });

        let contacts = await Promise.all(contactsPromises);

        // فلترة النتائج حسب مصطلح البحث (بحث في الاسم الأول والأخير)
        const searchLower = searchTerm.toLowerCase();
        contacts = contacts.filter(contact =>
            contact && (
                (contact.firstname && contact.firstname.toLowerCase().includes(searchLower)) ||
                (contact.lastname && contact.lastname.toLowerCase().includes(searchLower)) ||
                (`${contact.firstname || ''} ${contact.lastname || ''}`.toLowerCase().includes(searchLower))
            )
        );

        // ترتيب النتائج حسب تاريخ آخر رسالة (الأحدث أولاً)
        contacts.sort((a, b) => new Date(b.last_message_date) - new Date(a.last_message_date));

        // تطبيق Pagination
        const totalCount = contacts.length;
        const totalPages = Math.ceil(totalCount / limit);
        const paginatedContacts = contacts.slice(offset, offset + limit);

        // جلب آخر رسالة لكل contact
        const contactsWithLastMessage = await Promise.all(paginatedContacts.map(async (contact) => {
            // جلب آخر رسالة مع هذا المستخدم
            const [lastMessageRows] = await db.query(
                `SELECT * FROM messages 
                 WHERE (sender_id = ? AND receiver_id = ?) 
                    OR (sender_id = ? AND receiver_id = ?) 
                 ORDER BY created_at DESC 
                 LIMIT 1`,
                [myId, contact.id, contact.id, myId]
            );

            // جلب عدد الرسائل غير المقروءة من هذا المستخدم
            const [unreadRows] = await db.query(
                `SELECT COUNT(*) as unread_count 
                 FROM messages 
                 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
                [contact.id, myId]
            );

            const lastMessage = lastMessageRows[0] || null;
            const unreadCount = unreadRows[0]?.unread_count || 0;

            // تنسيق آخر رسالة للعرض
            let lastMessagePreview = null;
            if (lastMessage) {
                lastMessagePreview = {
                    id: lastMessage.id,
                    content: lastMessage.content,
                    type: lastMessage.type || 'text',
                    created_at: lastMessage.created_at,
                    is_mine: lastMessage.sender_id === myId,
                    is_read: lastMessage.is_read === 1,
                    is_delivered: lastMessage.is_delivered === 1
                };
            }

            return {
                contact_info: {
                    id: contact.id,
                    firstname: contact.firstname || '',
                    lastname: contact.lastname || '',
                    fullname: `${contact.firstname || ''} ${contact.lastname || ''}`.trim(),
                    imagePath: contact.imagePath || null,
                    bio: contact.bio || null,
                    email: contact.email || null,
                    whatsappLink: contact.whatsappLink || null,
                    facebookLink: contact.facebookLink || null,
                    telegramLink: contact.telegramLink || null,
                    linkedinLink: contact.linkedinLink || null
                },
                last_message: lastMessagePreview,
                unread_count: unreadCount,
                last_message_date: contact.last_message_date
            };
        }));

        res.json(formatResponse(
            true,
            'Contacts searched successfully',
            {
                meta: {
                    current_page: page,
                    per_page: limit,
                    total_count: totalCount,
                    total_pages: totalPages,
                    search_term: searchTerm
                },
                data: contactsWithLastMessage
            },
            [],
            200
        ));

    } catch (err) {
        console.error('Error in /search-contacts:', err);
        res.status(500).json(formatResponse(false, 'Failed to search contacts', null, [err.message], 500));
    }
});

// 4. (اختياري) بحث مبسط يعيد فقط قائمة المستخدمين المتطابقين
router.get('/search-contacts/simple', authMiddleware, async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json(formatResponse(false, 'No token provided', null, ['Authentication token is missing'], 401));
    }

    const myId = req.user.id;
    const searchTerm = req.query.q || '';

    if (!searchTerm.trim()) {
        return res.status(400).json(formatResponse(false, 'Search term is required', null, ['Please provide a search query'], 400));
    }

    try {
        // جلب جميع الـ contacts
        const contactsSql = `
            SELECT DISTINCT 
                CASE 
                    WHEN sender_id = ? THEN receiver_id 
                    ELSE sender_id 
                END as contact_id
            FROM messages 
            WHERE sender_id = ? OR receiver_id = ?
        `;

        const [contactRows] = await db.query(contactsSql, [myId, myId, myId]);

        if (contactRows.length === 0) {
            return res.json(formatResponse(
                true,
                'No contacts found',
                { data: [] },
                [],
                200
            ));
        }

        // جلب بيانات contacts
        const contactsPromises = contactRows.map(contact => fetchUserData(contact.contact_id, token));
        let contacts = await Promise.all(contactsPromises);

        // فلترة حسب البحث
        const searchLower = searchTerm.toLowerCase();
        const filteredContacts = contacts.filter(contact =>
            contact && (
                (contact.firstname && contact.firstname.toLowerCase().includes(searchLower)) ||
                (contact.lastname && contact.lastname.toLowerCase().includes(searchLower)) ||
                (`${contact.firstname || ''} ${contact.lastname || ''}`.toLowerCase().includes(searchLower))
            )
        );

        // تنسيق النتائج المبسطة
        const simplifiedResults = filteredContacts.map(contact => ({
            id: contact.id,
            firstname: contact.firstname || '',
            lastname: contact.lastname || '',
            fullname: `${contact.firstname || ''} ${contact.lastname || ''}`.trim(),
            imagePath: contact.imagePath || null
        }));

        res.json(formatResponse(
            true,
            'Contacts searched successfully',
            { data: simplifiedResults },
            [],
            200
        ));

    } catch (err) {
        console.error('Error in /search-contacts/simple:', err);
        res.status(500).json(formatResponse(false, 'Failed to search contacts', null, [err.message], 500));
    }
});

module.exports = router;