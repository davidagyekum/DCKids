const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');

const dbPath = process.env.DB_PATH || path.resolve(__dirname, 'inventory.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');

        // Run every statement below in submission order. Without this, node-sqlite3
        // does not guarantee ordering, so on a fresh database the CREATE INDEX and
        // seed statements can race ahead of their CREATE TABLE / ALTER and crash with
        // "no such table" / "no such column". Serialized mode is sticky on the
        // connection, so it also orders the async migrations and seeds below.
        db.serialize();

        // Concurrency hardening:
        // - WAL lets readers and a writer work simultaneously (default mode blocks readers during a write).
        // - busy_timeout makes a blocked write wait up to 5s instead of throwing SQLITE_BUSY under load.
        // - foreign_keys enforces the relationships we declare.
        db.run('PRAGMA journal_mode = WAL');
        db.run('PRAGMA busy_timeout = 5000');
        db.run('PRAGMA foreign_keys = ON');

        // Create users table
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password_hash TEXT,
            role TEXT
        )`, (err) => {
            if (err) console.error("Error creating users table", err);

            // Migration: access-request workflow columns. status drives access:
            // 'active' may sign in, 'pending' awaits approval, 'rejected' is
            // refused. Admin auth is passwordless (email 6-digit OTP), so
            // password_hash is unused for admins and stays NULL.
            db.all("PRAGMA table_info(users)", (e, cols) => {
                if (e || !cols) return;
                const names = cols.map(c => c.name);
                const addCol = (ddl, label) => db.run("ALTER TABLE users ADD COLUMN " + ddl, (er) => {
                    if (er) console.error("Migration (users." + label + ") failed:", er.message);
                    else console.log("Migration: added users." + label);
                });
                if (names.indexOf('email') === -1) addCol("email TEXT", "email");
                if (names.indexOf('full_name') === -1) addCol("full_name TEXT", "full_name");
                if (names.indexOf('phone') === -1) addCol("phone TEXT", "phone");
                if (names.indexOf('status') === -1) addCol("status TEXT", "status");
                if (names.indexOf('created_at') === -1) addCol("created_at TEXT", "created_at");
                // recovery_shown: set to 1 once the user's one-time recovery codes
                // have been displayed (owner at sign-up, staff at first login), so
                // we never re-show them or keep them in plaintext.
                if (names.indexOf('recovery_shown') === -1) addCol("recovery_shown INTEGER DEFAULT 0", "recovery_shown");
                // google_sub: the Google account's stable subject id, bound on
                // first "Continue with Google" sign-in. We authenticate by
                // verified email; this is stored for audit and to detect an email
                // later reassigned to a different Google account.
                if (names.indexOf('google_sub') === -1) addCol("google_sub TEXT", "google_sub");
                db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL", (er) => {
                    if (er) console.error("Migration (idx_users_email) failed:", er.message);
                });
            });

            // No default admin is seeded. The very first person to complete the
            // sign-up form is auto-activated as the owner (manager); everyone
            // after them goes through the pending -> approve flow. See
            // /api/admin/register in server.js.
        });

        // Short-lived email sign-in codes (OTP). One active code per user; the
        // request endpoint clears old codes before inserting a fresh one.
        db.run(`CREATE TABLE IF NOT EXISTS auth_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            code_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users (id)
        )`, (err) => { if (err) console.error("Error creating auth_codes table", err); });

        // One-time recovery codes: the account's backup way in if email fails.
        // Stored hashed; marked used_at once redeemed.
        db.run(`CREATE TABLE IF NOT EXISTS recovery_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            code_hash TEXT NOT NULL,
            used_at TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users (id)
        )`, (err) => { if (err) console.error("Error creating recovery_codes table", err); });

        // Create products table
        db.run(`CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            sku TEXT,
            size TEXT,
            price REAL,
            img TEXT,
            cat TEXT,
            stock INTEGER DEFAULT 10,
            badge TEXT,
            description TEXT,
            fulfillment_type TEXT DEFAULT 'in_stock',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) console.error("Error creating products table", err);

            // Migration: add sku to pre-existing DBs that lack it, then enforce
            // uniqueness on real SKUs (the partial index still allows many NULLs,
            // so legacy rows without a SKU are unaffected). The index must be
            // created only after the column exists, so it's nested in the ALTER
            // callback rather than queued alongside it.
            const ensureSkuIndex = () => {
                db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku ON products(sku) WHERE sku IS NOT NULL", (er) => {
                    if (er) console.error("Migration (idx_products_sku) failed:", er.message);
                });
            };
            db.all("PRAGMA table_info(products)", (e, cols) => {
                if (e || !cols) return;
                const names = cols.map(c => c.name);
                if (names.indexOf('sku') === -1) {
                    db.run("ALTER TABLE products ADD COLUMN sku TEXT", (er) => {
                        if (er) { console.error("Migration (products.sku) failed:", er.message); return; }
                        console.log("Migration: added products.sku");
                        ensureSkuIndex();
                    });
                } else {
                    ensureSkuIndex();
                }
                // Migration: add description to pre-existing DBs that lack it.
                if (names.indexOf('description') === -1) {
                    db.run("ALTER TABLE products ADD COLUMN description TEXT", (er) => {
                        if (er) console.error("Migration (products.description) failed:", er.message);
                        else console.log("Migration: added products.description");
                    });
                }

                // Migration: fulfillment_type decouples "is this a pre-order" from
                // category, which used to overload cat='preorder' (so a pre-order
                // pair of shoes was invisible under the real "Shoes" category).
                // Backfill legacy rows: flag them as preorder and move them into a
                // real category inferred from their name, since the fake "preorder"
                // category never told us what they actually were.
                if (names.indexOf('fulfillment_type') === -1) {
                    db.run("ALTER TABLE products ADD COLUMN fulfillment_type TEXT DEFAULT 'in_stock'", (er) => {
                        if (er) { console.error("Migration (products.fulfillment_type) failed:", er.message); return; }
                        console.log("Migration: added products.fulfillment_type");
                        db.all("SELECT id, name FROM products WHERE cat = 'preorder'", [], (e2, rows) => {
                            if (e2 || !rows || !rows.length) return;
                            const inferCategory = (name) => {
                                const n = (name || '').toLowerCase();
                                if (/shoe|sneaker|boot|sandal|cloq/.test(n)) return 'shoes';
                                if (/coat|suit|gown|dress|outfit|set\b/.test(n)) return 'clothing';
                                if (/bedding|mattress|furniture|blanket/.test(n)) return 'bedding';
                                if (/watch|accessor/.test(n)) return 'accessories';
                                if (/baby|newborn/.test(n)) return 'newborn';
                                return 'essentials';
                            };
                            const backfillStmt = db.prepare("UPDATE products SET cat = ?, fulfillment_type = 'preorder' WHERE id = ?");
                            rows.forEach(p => backfillStmt.run(inferCategory(p.name), p.id));
                            backfillStmt.finalize(() => {
                                console.log(`Migration: backfilled ${rows.length} legacy preorder product(s) into real categories`);
                            });
                        });
                    });
                }

                // Migration: sizes holds admin-managed size variants as JSON,
                // [{ "label": "0-3M", "price": 85 }, ...]. When present it is
                // authoritative for the storefront dropdown AND order totals;
                // when NULL the app falls back to the legacy parseSize +
                // getPriceModifier behavior, so the existing catalogue keeps
                // working until each product is edited in the admin.
                if (names.indexOf('sizes') === -1) {
                    db.run("ALTER TABLE products ADD COLUMN sizes TEXT", (er) => {
                        if (er) console.error("Migration (products.sizes) failed:", er.message);
                        else console.log("Migration: added products.sizes");
                    });
                }
            });

            // Seed products if empty. Prefer the live catalogue snapshot
            // (../products.json — the same file the storefront uses as its
            // offline fallback) so a fresh clone starts with the REAL shop:
            // every storefront category populated, managed sizes included.
            // The built-in array below only kicks in if the snapshot is
            // missing or unreadable.
            db.get(`SELECT COUNT(*) as count FROM products`, (err, row) => {
                if (row.count === 0) {
                    let snapshot = null;
                    try {
                        const fs = require('fs');
                        const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'products.json'), 'utf8'));
                        const arr = Array.isArray(raw) ? raw : raw.products;
                        if (Array.isArray(arr) && arr.length) snapshot = arr;
                    } catch (e) { /* fall through to built-in seed */ }

                    if (snapshot) {
                        console.log(`Seeding catalogue from products.json (${snapshot.length} products)...`);
                        const snapStmt = db.prepare(`INSERT INTO products
                            (id, name, sku, size, price, img, cat, stock, badge, description, fulfillment_type, sizes)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                        snapshot.forEach(p => {
                            const sizes = (p.sizes && typeof p.sizes === 'object') ? JSON.stringify(p.sizes)
                                : (typeof p.sizes === 'string' && p.sizes.trim() ? p.sizes : null);
                            snapStmt.run(p.id, p.name, p.sku || null, p.size || '', p.price, p.img || '', p.cat || '',
                                Number.isFinite(Number(p.stock)) ? Number(p.stock) : 10, p.badge || '',
                                p.description || null, p.fulfillment_type || 'in_stock', sizes);
                        });
                        snapStmt.finalize(() => console.log("Database seeded from catalogue snapshot."));
                        return;
                    }

                    console.log("Seeding initial products...");
                    const productsData = [
                        { id:1,  name:"Boys 3-Piece Sailor Set",         size:"6M – 24M",   price:85,   img:"images/product_56.jpg", cat:"clothing",    stock:10, badge:"new" },
                        { id:2,  name:"Girls Floral Summer Dress",        size:"2Y – 5Y",    price:70,   img:"images/product_57.jpg", cat:"clothing",    stock:5, badge:"hot" },
                        { id:3,  name:"Kids' Casual 2-Piece Set",         size:"1Y – 4Y",    price:65,   img:"images/product_58.jpg", cat:"clothing",    stock:12, badge:"new" },
                        { id:4,  name:"Baby Romper & Hat Set",             size:"0 – 12M",   price:55,   img:"images/product_59.jpg", cat:"clothing",    stock:8, badge:"" },
                        { id:5,  name:"Boys Shirt & Shorts Combo",        size:"1Y – 5Y",    price:60,   img:"images/product_60.jpg", cat:"clothing",    stock:15, badge:"" },
                        { id:6,  name:"Girls Party Dress",                size:"3Y – 8Y",    price:95,   img:"images/product_61.jpg", cat:"clothing",    stock:3, badge:"hot" },
                        { id:7,  name:"Toddler Dungaree Set",             size:"6M – 3Y",   price:75,   img:"images/product_62.jpg", cat:"clothing",    stock:9, badge:"new" },
                        { id:8,  name:"Kids' Printed T-Shirt",            size:"2Y – 8Y",    price:40,   img:"images/product_63.jpg", cat:"clothing",    stock:20, badge:"" },
                        { id:9,  name:"Trendy Boys Outfit",               size:"3Y – 10Y",   price:80,   img:"images/product_64.jpg", cat:"clothing",    stock:7, badge:"" },
                        { id:10, name:"Girls Plaid Dress Set",             size:"4Y – 10Y",  price:90,   img:"images/product_38.jpg", cat:"clothing",    stock:6, badge:"hot" },
                        { id:11, name:"Boys Formal Shirt & Shorts",       size:"2Y – 8Y",    price:85,   img:"images/product_39.jpg", cat:"clothing",    stock:10, badge:"new" },
                        { id:12, name:"Kids' Casual Summer Wear",         size:"1Y – 6Y",    price:55,   img:"images/product_40.jpg", cat:"clothing",    stock:11, badge:"" },
                        { id:13, name:"Baby Girl Dress",                  size:"6M – 3Y",   price:65,   img:"images/product_41.jpg", cat:"clothing",    stock:14, badge:"" },
                        { id:14, name:"Boys Polo Collection",             size:"3Y – 10Y",   price:50,   img:"images/product_42.jpg", cat:"clothing",    stock:18, badge:"" },
                        { id:15, name:"Kids' Denim & Tee Set",            size:"2Y – 8Y",    price:75,   img:"images/product_43.jpg", cat:"clothing",    stock:8, badge:"new" },
                        { id:16, name:"Party Wear Outfit",                size:"1Y – 6Y",    price:100,  img:"images/product_44.jpg", cat:"clothing",    stock:5, badge:"hot" },
                        { id:17, name:"Unisex Cotton Romper",             size:"0 – 18M",   price:45,   img:"images/product_45.jpg", cat:"clothing",    stock:25, badge:"" },
                        { id:18, name:"Girls Floral Skirt Set",           size:"2Y – 7Y",    price:70,   img:"images/product_46.jpg", cat:"clothing",    stock:6, badge:"" },
                        { id:19, name:"Boys Tracksuit",                   size:"3Y – 10Y",   price:85,   img:"images/product_47.jpg", cat:"clothing",    stock:4, badge:"" },
                        { id:20, name:"Character Print Outfit",           size:"1Y – 5Y",    price:60,   img:"images/product_48.jpg", cat:"clothing",    stock:15, badge:"new" },
                        { id:21, name:"Kids' Smart Casual Set",           size:"4Y – 12Y",   price:90,   img:"images/product_49.jpg", cat:"clothing",    stock:7, badge:"" },
                        { id:22, name:"Baby Bodysuit Pack",               size:"0 – 12M",   price:35,   img:"images/product_50.jpg", cat:"clothing",    stock:30, badge:"" },
                        { id:23, name:"Wholesale Kids' Mix",              size:"Assorted",    price:40,   img:"images/product_51.jpg", cat:"clothing",    stock:50, badge:"" },
                        { id:24, name:"Store Collection Display",         size:"0 – 12Y",   price:null, img:"images/product_81.jpg", cat:"clothing",    stock:10, badge:"" },
                        { id:25, name:"Kids' Fashion Mix",                size:"Assorted",    price:null, img:"images/product_82.jpg", cat:"clothing",    stock:10, badge:"" },
                        
                        { id:26, name:"Kids' White Sneakers",             size:"Size 25–35", price:60,   img:"images/product_66.jpg", cat:"shoes",       stock:10, badge:"new" },
                        { id:27, name:"Girls' Pink Sandals",              size:"Size 22–30", price:50,   img:"images/product_67.jpg", cat:"shoes",       stock:5, badge:"" },
                        { id:28, name:"Boys' Formal School Shoes",        size:"Size 28–36", price:70,   img:"images/product_68.jpg", cat:"shoes",       stock:12, badge:"" },
                        { id:29, name:"Baby First-Walker Shoes",          size:"Size 15–21", price:45,   img:"images/product_69.jpg", cat:"shoes",       stock:8, badge:"hot" },
                        { id:30, name:"Kids' Crocs & Clogs",              size:"Size 24–34", price:40,   img:"images/product_70.jpg", cat:"shoes",       stock:20, badge:"" },
                        { id:31, name:"Sports Running Sneakers",          size:"Size 26–36", price:65,   img:"images/product_71.jpg", cat:"shoes",       stock:15, badge:"new" },
                        { id:32, name:"Canvas Slip-On Shoes",             size:"Size 22–30", price:55,   img:"images/product_72.jpg", cat:"shoes",       stock:10, badge:"" },
                        { id:33, name:"LED Light-Up Sneakers",            size:"Size 25–34", price:75,   img:"images/product_73.jpg", cat:"shoes",       stock:7, badge:"hot" },
                        { id:34, name:"Velcro Strap Shoes",               size:"Size 20–28", price:50,   img:"images/product_74.jpg", cat:"shoes",       stock:14, badge:"" },
                        { id:35, name:"Boys' Football Boots",             size:"Size 28–38", price:85,   img:"images/product_75.jpg", cat:"shoes",       stock:6, badge:"" },
                        { id:36, name:"Girls' Ballet Flats",              size:"Size 24–32", price:55,   img:"images/product_76.jpg", cat:"shoes",       stock:11, badge:"new" },
                        { id:37, name:"Kids' Winter Boots",               size:"Size 25–35", price:90,   img:"images/product_77.jpg", cat:"shoes",       stock:4, badge:"" },
                        
                        { id:38, name:"Designer Sunglasses",              size:"One Size",   price:25,   img:"images/product_2.jpg",  cat:"accessories", stock:25, badge:"hot" },
                        { id:39, name:"Kids' Baseball Cap",               size:"Adjustable", price:30,   img:"images/product_3.jpg",  cat:"accessories", stock:18, badge:"" },
                        { id:40, name:"Girls' Hair Accessories",          size:"Pack of 5",  price:20,   img:"images/product_4.jpg",  cat:"accessories", stock:30, badge:"new" },
                        { id:41, name:"Winter Beanie & Scarf",            size:"2Y – 8Y",    price:45,   img:"images/product_5.jpg",  cat:"accessories", stock:12, badge:"" },
                        { id:42, name:"Kids' Digital Watch",              size:"Adjustable", price:35,   img:"images/product_6.jpg",  cat:"accessories", stock:15, badge:"" },
                        { id:43, name:"Novelty Fun Socks",                size:"3 Pairs",    price:20,   img:"images/product_7.jpg",  cat:"accessories", stock:40, badge:"" },
                        
                        { id:44, name:"Baby Essentials Bundle",           size:"0 – 6M",    price:120,  img:"images/product_8.jpg",  cat:"baby",        stock:5, badge:"hot" },
                        { id:45, name:"Premium Baby Bedding",             size:"Standard",   price:150,  img:"images/product_9.jpg",  cat:"baby",        stock:8, badge:"" },
                        { id:46, name:"Baby Gear & Carrier",              size:"Up to 15kg", price:200,  img:"images/product_10.jpg", cat:"baby",        stock:4, badge:"new" },
                        { id:47, name:"Newborn Starter Kit",              size:"0 – 3M",    price:85,   img:"images/product_53.jpg", cat:"baby",        stock:10, badge:"" },
                        { id:48, name:"Soft Cotton Swaddles",             size:"Pack of 3",  price:45,   img:"images/product_54.jpg", cat:"baby",        stock:20, badge:"" },
                        
                        { id:49, name:"Primary School Backpack",          size:"Standard",   price:65,   img:"images/product_29.jpg", cat:"bags",        stock:15, badge:"new" },
                        { id:50, name:"Kindergarten Mini Bag",            size:"Small",      price:45,   img:"images/product_30.jpg", cat:"bags",        stock:12, badge:"" },
                        { id:51, name:"Cartoon Character Bag",            size:"Medium",     price:55,   img:"images/product_31.jpg", cat:"bags",        stock:8, badge:"hot" },
                        { id:52, name:"Waterproof School Bag",            size:"Large",      price:80,   img:"images/product_32.jpg", cat:"bags",        stock:10, badge:"" },
                        { id:53, name:"Girls' Sequin Backpack",           size:"Standard",   price:70,   img:"images/product_33.jpg", cat:"bags",        stock:6, badge:"" },
                        { id:54, name:"Boys' Superhero Bag",              size:"Standard",   price:70,   img:"images/product_34.jpg", cat:"bags",        stock:14, badge:"new" },
                        { id:55, name:"Trolley School Bag",               size:"Large",      price:120,  img:"images/product_35.jpg", cat:"bags",        stock:5, badge:"" },
                        
                        { id:56, name:"Luxury Kids' Bedding Set",         size:"Single Bed", price:180,  img:"images/product_13.jpg", cat:"bedding",     stock:4, badge:"hot" },
                        { id:57, name:"Cartoon Print Bedsheet",           size:"Single Bed", price:85,   img:"images/product_14.jpg", cat:"bedding",     stock:10, badge:"" },
                        { id:58, name:"Cozy Baby Blanket",                size:"Standard",   price:50,   img:"images/product_15.jpg", cat:"bedding",     stock:15, badge:"new" },
                        { id:59, name:"Toddler Pillow & Cover",           size:"Small",      price:35,   img:"images/product_16.jpg", cat:"bedding",     stock:20, badge:"" },
                        { id:60, name:"Girls' Princess Bedding",          size:"Single Bed", price:120,  img:"images/product_17.jpg", cat:"bedding",     stock:7, badge:"" },
                        { id:61, name:"Boys' Cars Bedding Set",           size:"Single Bed", price:120,  img:"images/product_18.jpg", cat:"bedding",     stock:8, badge:"" },
                        { id:62, name:"Soft Fleece Throw",                size:"Standard",   price:40,   img:"images/product_19.jpg", cat:"bedding",     stock:25, badge:"" },
                        { id:63, name:"Premium Crib Mattress",            size:"Crib Size",  price:200,  img:"images/product_20.jpg", cat:"bedding",     stock:3, badge:"" },
                        { id:64, name:"Waterproof Mattress Protector",    size:"Single Bed", price:60,   img:"images/product_21.jpg", cat:"bedding",     stock:12, badge:"" },
                        { id:65, name:"Dinosaur Print Bedding",           size:"Single Bed", price:90,   img:"images/product_22.jpg", cat:"bedding",     stock:9, badge:"new" },
                        { id:66, name:"Unicorn Dream Bedding",            size:"Single Bed", price:90,   img:"images/product_23.jpg", cat:"bedding",     stock:6, badge:"" },
                        { id:67, name:"Space Theme Bedsheet",             size:"Single Bed", price:85,   img:"images/product_24.jpg", cat:"bedding",     stock:11, badge:"" },
                        { id:68, name:"Baby Sleep Sack",                  size:"0 – 12M",   price:45,   img:"images/product_25.jpg", cat:"bedding",     stock:14, badge:"" },
                        { id:69, name:"Cotton Muslin Quilt",              size:"Standard",   price:75,   img:"images/product_26.jpg", cat:"bedding",     stock:10, badge:"" },
                        { id:70, name:"Kids' Travel Neck Pillow",         size:"One Size",   price:25,   img:"images/product_27.jpg", cat:"bedding",     stock:18, badge:"" },
                        
                        // China Pre-Order Items — real category + fulfillment_type:"preorder",
                        // so they show up under their actual category (badged as pre-order)
                        // instead of only inside a fake "preorder" category.
                        { id:71, name:"Pre-Order: Luxury Winter Coat",    size:"2Y – 10Y",   price:150,  img:"images/product_78.jpg", cat:"clothing",    stock:10, badge:"china", fulfillment_type:"preorder" },
                        { id:72, name:"Pre-Order: Designer Sneakers",     size:"Size 26–36", price:120,  img:"images/product_83.jpg", cat:"shoes",       stock:10, badge:"china", fulfillment_type:"preorder" },
                        { id:73, name:"Pre-Order: Formal Suit Set",       size:"3Y – 12Y",   price:200,  img:"images/product_11.jpg", cat:"clothing",    stock:10, badge:"china", fulfillment_type:"preorder" },
                        { id:74, name:"Pre-Order: Princess Gown",         size:"4Y – 10Y",   price:180,  img:"images/product_12.jpg", cat:"clothing",    stock:10, badge:"china", fulfillment_type:"preorder" },
                        { id:75, name:"Pre-Order: Premium Baby Gear",     size:"One Size",   price:250,  img:"images/product_28.jpg", cat:"newborn",     stock:10, badge:"china", fulfillment_type:"preorder" },
                        { id:76, name:"Pre-Order: School Tech Bundle",    size:"Assorted",    price:300,  img:"images/product_36.jpg", cat:"essentials",  stock:10, badge:"china", fulfillment_type:"preorder" },
                        { id:77, name:"Pre-Order: Boutique Shoe Mix",     size:"Assorted",    price:null, img:"images/product_37.jpg", cat:"shoes",       stock:10, badge:"china", fulfillment_type:"preorder" },
                        { id:78, name:"Pre-Order: Kids Smartwatch",       size:"One Size",   price:85,   img:"images/product_55.jpg", cat:"accessories", stock:10, badge:"china", fulfillment_type:"preorder" },
                        { id:79, name:"Pre-Order: Playroom Furniture",    size:"Standard",   price:450,  img:"images/product_65.jpg", cat:"bedding",     stock:10, badge:"china", fulfillment_type:"preorder" },
                        { id:80, name:"Pre-Order: Bulk Stock Request",    size:"Custom",     price:null, img:"images/product_79.jpg", cat:"essentials",  stock:10, badge:"china", fulfillment_type:"preorder" }
                    ];

                    const stmt = db.prepare("INSERT INTO products (id, name, size, price, img, cat, stock, badge, fulfillment_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
                    productsData.forEach(p => {
                        stmt.run(p.id, p.name, p.size, p.price, p.img, p.cat, p.stock, p.badge, p.fulfillment_type || 'in_stock');
                    });
                    stmt.finalize();
                    console.log("Database seeded successfully.");
                }
            });
        });

        // Create transactions table for audit logging
        db.run(`CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER,
            username TEXT,
            action TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) console.error("Error creating transactions table", err);
        });

        // Create store_settings table
        db.run(`CREATE TABLE IF NOT EXISTS store_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            whatsapp_number TEXT NOT NULL,
            wholesale_enabled BOOLEAN NOT NULL DEFAULT 1,
            wholesale_moq INTEGER NOT NULL DEFAULT 10,
            wholesale_discount INTEGER NOT NULL DEFAULT 0,
            banner_enabled BOOLEAN NOT NULL DEFAULT 1,
            banner_text TEXT
        )`, (err) => {
            if (err) console.error("Error creating store_settings table", err);
            
            // Seed the initial defaults (safely ignores if row 1 already exists)
            db.run(`INSERT OR IGNORE INTO store_settings 
                (id, whatsapp_number, wholesale_enabled, wholesale_moq, wholesale_discount, banner_enabled, banner_text) 
                VALUES 
                (1, '233549193805', 1, 10, 20, 1, "China Pre-Order Window OPEN! Orders close May 18th — Don't miss out!")`, 
                (err) => {
                    if (err) console.error("Error seeding store_settings", err);
                    else console.log("Default store settings verified.");
                }
            );
        });

        // Create suppliers table
        db.run(`CREATE TABLE IF NOT EXISTS suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            supplier_name TEXT NOT NULL UNIQUE,
            contact_person TEXT NOT NULL,
            email TEXT NOT NULL,
            phone TEXT NOT NULL,
            business_address TEXT NOT NULL,
            products_supplied TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            notes TEXT,
            supplier_logo TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) console.error("Error creating suppliers table", err);

            const suppliersData = [
                {
                    supplier_name: 'Little Stars Textiles',
                    contact_person: 'Grace Adjei',
                    email: 'grace@littlestars.com',
                    phone: '+233302221111',
                    business_address: 'Accra Central, Ghana',
                    products_supplied: 'Clothing, Baby Essentials',
                    status: 'active',
                    notes: 'Core clothing and romper supplier.',
                    supplier_logo: ''
                },
                {
                    supplier_name: 'TinyFeet Footwear',
                    contact_person: 'Michael Osei',
                    email: 'michael@tinyfeet.com',
                    phone: '+233302222222',
                    business_address: 'Spintex Road, Accra',
                    products_supplied: 'Shoes, Accessories',
                    status: 'active',
                    notes: 'Kids shoes and sandal supplier.',
                    supplier_logo: ''
                },
                {
                    supplier_name: 'BabyComfort Ltd',
                    contact_person: 'Sarah Mensah',
                    email: 'sarah@babycomfort.com',
                    phone: '+233302223333',
                    business_address: 'North Kaneshie, Accra',
                    products_supplied: 'Baby Essentials, Toys',
                    status: 'active',
                    notes: 'Baby care and essentials partner.',
                    supplier_logo: ''
                },
                {
                    supplier_name: 'KidsBag World',
                    contact_person: 'Daniel Tetteh',
                    email: 'daniel@kidsbag.com',
                    phone: '+233302224444',
                    business_address: 'Kasoa, Central Region',
                    products_supplied: 'Accessories, Toys',
                    status: 'inactive',
                    notes: 'Seasonal bags and accessories supplier.',
                    supplier_logo: ''
                }
            ];

            db.get(`SELECT COUNT(*) as count FROM suppliers`, (err, row) => {
                if (err || !row || row.count > 0) return;

                const stmt = db.prepare(`INSERT INTO suppliers
                    (supplier_name, contact_person, email, phone, business_address, products_supplied, status, notes, supplier_logo)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

                suppliersData.forEach((s) => {
                    stmt.run(
                        s.supplier_name,
                        s.contact_person,
                        s.email,
                        s.phone,
                        s.business_address,
                        s.products_supplied,
                        s.status,
                        s.notes,
                        s.supplier_logo
                    );
                });
                stmt.finalize();
                console.log("Default suppliers verified.");
            });
        });

        // Create customers table for analytics relationships
        db.run(`CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT UNIQUE,
            email TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) console.error("Error creating customers table", err);
        });

        // Create orders table
        db.run(`CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_number TEXT UNIQUE NOT NULL,
            customer_name TEXT,
            customer_phone TEXT,
            order_type TEXT,
            total_amount REAL,
            status TEXT,
            delivery_area TEXT,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) console.error("Error creating orders table", err);

            // Migration: add delivery_area / notes to pre-existing DBs that lack them.
            db.all("PRAGMA table_info(orders)", (e, cols) => {
                if (e || !cols) return;
                const names = cols.map(c => c.name);
                if (names.indexOf('delivery_area') === -1) {
                    db.run("ALTER TABLE orders ADD COLUMN delivery_area TEXT", (er) => {
                        if (er) console.error("Migration (delivery_area) failed:", er.message);
                        else console.log("Migration: added orders.delivery_area");
                    });
                }
                if (names.indexOf('notes') === -1) {
                    db.run("ALTER TABLE orders ADD COLUMN notes TEXT", (er) => {
                        if (er) console.error("Migration (notes) failed:", er.message);
                        else console.log("Migration: added orders.notes");
                    });
                }
            });
        });

        // Create order_items table
        db.run(`CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            product_id INTEGER,
            product_name TEXT,
            quantity INTEGER,
            price_at_time REAL,
            FOREIGN KEY (order_id) REFERENCES orders (id)
        )`, (err) => {
            if (err) console.error("Error creating order_items table", err);
        });

        // Create payments table for analytics insights
        db.run(`CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            payment_method TEXT NOT NULL DEFAULT 'Mobile Money',
            amount REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (order_id) REFERENCES orders (id)
        )`, (err) => {
            if (err) console.error("Error creating payments table", err);
        });

        // Create product_images table for the preview gallery
        db.run(`CREATE TABLE IF NOT EXISTS product_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER,
            image_url TEXT,
            FOREIGN KEY (product_id) REFERENCES products (id)
        )`, (err) => {
            if (err) console.error("Error creating product_images table", err);
            
            // Seed product_images table if empty
            db.get(`SELECT COUNT(*) as count FROM product_images`, (err, row) => {
                if (!err && row && row.count === 0) {
                    console.log("Seeding product images gallery...");
                    db.all("SELECT id, img, cat FROM products", [], (err, products) => {
                        if (err || !products) return;
                        const stmt = db.prepare("INSERT INTO product_images (product_id, image_url) VALUES (?, ?)");
                        products.forEach(p => {
                            // Main image
                            stmt.run(p.id, p.img);
                            // Alternate images (siblings in the same category)
                            const siblings = products.filter(s => s.cat === p.cat && s.id !== p.id).slice(0, 3);
                            siblings.forEach(sib => {
                                stmt.run(p.id, sib.img);
                            });
                            // Fill in if fewer than 4 images
                            for (let i = siblings.length; i < 3; i++) {
                                stmt.run(p.id, p.img);
                            }
                        });
                        stmt.finalize();
                        console.log("Product images gallery seeded successfully.");
                    });
                }
            });
        });

        // ===== Customer accounts (storefront login) =====
        db.run(`CREATE TABLE IF NOT EXISTS customer_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            phone TEXT,
            name TEXT,
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login_at DATETIME
        )`, (err) => { if (err) console.error("Error creating customer_accounts table", err); });

        // Saved delivery addresses per customer
        db.run(`CREATE TABLE IF NOT EXISTS customer_addresses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            label TEXT,
            recipient_name TEXT,
            phone TEXT,
            address_line1 TEXT NOT NULL,
            address_line2 TEXT,
            city TEXT,
            region TEXT,
            country TEXT DEFAULT 'Ghana',
            is_default INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES customer_accounts (id)
        )`, (err) => { if (err) console.error("Error creating customer_addresses table", err); });

        // Product reviews
        db.run(`CREATE TABLE IF NOT EXISTS product_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            customer_id INTEGER,
            author_name TEXT NOT NULL,
            rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
            title TEXT,
            body TEXT,
            verified_purchase INTEGER DEFAULT 0,
            status TEXT DEFAULT 'approved',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products (id),
            FOREIGN KEY (customer_id) REFERENCES customer_accounts (id)
        )`, (err) => { if (err) console.error("Error creating product_reviews table", err); });

        // Wishlist (per-customer favourites)
        db.run(`CREATE TABLE IF NOT EXISTS wishlist_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(customer_id, product_id),
            FOREIGN KEY (customer_id) REFERENCES customer_accounts (id),
            FOREIGN KEY (product_id) REFERENCES products (id)
        )`, (err) => { if (err) console.error("Error creating wishlist_items table", err); });

        // Link a server-side customer account to existing orders by phone match.
        // We don't ALTER orders schema — instead resolve via phone lookup at query time.

        // Indexes for the lookups that run on every page/admin load. Keep these
        // fast as rows grow into the tens/hundreds of thousands.
        db.run(`CREATE INDEX IF NOT EXISTS idx_orders_created_at   ON orders (created_at DESC)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_orders_phone        ON orders (customer_phone)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_orders_number       ON orders (order_number)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_order_items_order   ON order_items (order_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_reviews_product     ON product_reviews (product_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_wishlist_customer   ON wishlist_items (customer_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_products_cat        ON products (cat)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_payments_order      ON payments (order_id)`);

        // Schema is fully queued above. This trailing statement runs only after
        // every CREATE TABLE/INDEX has executed (single-connection serial queue),
        // so it's a reliable "schema ready" signal. The server waits on this via
        // db.whenReady() before listening — otherwise a request arriving on a
        // fresh database (no tables yet) crashes with "no such table: orders".
        db.run('SELECT 1', () => { _markDbReady(); });
    }
});

// ── Readiness gate ──
// Lets server.js delay app.listen() until the schema exists on a fresh DB.
let _dbReady = false;
const _dbReadyCbs = [];
function _markDbReady() { _dbReady = true; while (_dbReadyCbs.length) _dbReadyCbs.shift()(); }
db.whenReady = function (cb) { if (_dbReady) cb(); else _dbReadyCbs.push(cb); };

module.exports = db;
