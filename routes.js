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
// 1. جلب سجل المحادثة - نسخة Cursor Pagination مع أقواس صحيحة
router.get('/history/:contactId', authMiddleware, async (req, res) => {
    const myId = req.user.id;
    const contactId = req.params.contactId;

    // قراءة وتجهيز المعاملات
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const cursor = req.query.cursor ? parseInt(req.query.cursor) : null;

    try {
        // تحديث الرسائل المستلمة لتصبح مقروءة
        await db.query(
            `UPDATE messages SET is_read = 1 
             WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
            [contactId, myId]
        );

        // بناء الاستعلام الأساسي - مع أقواس صحيحة
        let sql = `
            SELECT * FROM messages 
            WHERE ((sender_id = ? AND receiver_id = ?) 
               OR (sender_id = ? AND receiver_id = ?))
        `;
        const params = [myId, contactId, contactId, myId];

        // إضافة شرط cursor إذا وُجد - داخل نفس مستوى الشروط
        if (cursor && !isNaN(cursor) && cursor > 0) {
            sql += ` AND id < ?`;
            params.push(cursor);
        }

        // ترتيب تنازلي وجلب عدد أكبر بواحد
        sql += ` ORDER BY id DESC LIMIT ?`;
        params.push(limit + 1);

        console.log('Final SQL:', sql);
        console.log('Params:', params);

        // تنفيذ الاستعلام
        const [rows] = await db.query(sql, params);

        // تحديد ما إذا كانت هناك صفحة تالية وحساب next_cursor
        let nextCursor = null;
        let data = rows;

        if (rows.length > limit) {
            data = rows.slice(0, limit);
            nextCursor = data[data.length - 1].id;
        }

        // إضافة حقل isMine لكل رسالة
        const enhancedRows = data.map(row => ({
            ...row,
            isMine: row.sender_id === myId
        }));

        // الرد مع معلومات إضافية للتأكد
        res.json(formatResponse(
            true,
            'Chat history retrieved successfully',
            {
                meta: {
                    limit: limit,
                    results_count: enhancedRows.length,
                    next_cursor: nextCursor,
                    cursor_received: cursor,
                    //sql_used: sql,
                    // params_used: params
                },
                data: enhancedRows
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
    const limit = 10; // Matching inbox limit
    const offset = (page - 1) * limit;

    // التحقق من وجود مصطلح بحث
    if (!searchTerm.trim()) {
        return res.status(400).json(formatResponse(false, 'Search term is required', null, ['Please provide a search query'], 400));
    }

    try {
        // First, get all conversations (similar to inbox)
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
            ORDER BY m1.created_at DESC`;

        const params = [myId, myId, myId, myId, myId, myId];
        const [rows] = await db.query(sql, params);

        if (rows.length === 0) {
            return res.json(formatResponse(
                true,
                'No contacts found',
                {
                    meta: {
                        current_page: page,
                        per_page: limit,
                        count: 0
                    },
                    data: []
                },
                [],
                200
            ));
        }

        // Fetch user data for all partners
        const allConversationsWithUsers = await Promise.all(rows.map(async (conv) => {
            const userData = await fetchUserData(conv.partner_id, token);

            return {
                ...conv,
                isMine: conv.sender_id === myId,
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

        // Filter conversations based on search term
        const searchLower = searchTerm.toLowerCase();
        const filteredConversations = allConversationsWithUsers.filter(conv => {
            const partner = conv.partner_info;
            const fullName = `${partner.firstname || ''} ${partner.lastname || ''}`.toLowerCase();
            const firstNameMatch = partner.firstname && partner.firstname.toLowerCase().includes(searchLower);
            const lastNameMatch = partner.lastname && partner.lastname.toLowerCase().includes(searchLower);
            const fullNameMatch = fullName.includes(searchLower);

            return firstNameMatch || lastNameMatch || fullNameMatch;
        });

        // Apply pagination
        const totalCount = filteredConversations.length;
        const totalPages = Math.ceil(totalCount / limit);
        const paginatedConversations = filteredConversations.slice(offset, offset + limit);

        // Format response to match inbox structure exactly
        const formattedData = paginatedConversations.map(conv => {
            // Remove partner_info and merge into root level
            const { partner_info, ...rest } = conv;
            return {
                ...rest,
                ...partner_info, // Spread partner_info to root level
                unread_count: conv.unread_count // Ensure unread_count is at root level
            };
        });

        res.json(formatResponse(
            true,
            'Contacts searched successfully',
            {
                meta: {
                    current_page: page,
                    per_page: limit,
                    count: paginatedConversations.length,
                    total_count: totalCount,
                    total_pages: totalPages,
                    search_term: searchTerm
                },
                data: formattedData
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