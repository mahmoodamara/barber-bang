
import express from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';

// Mock dependencies
const mockRes = {
    json: () => { },
    status: () => mockRes,
    send: () => { },
};
const mockReq = {
    user: { role: 'admin' },
    body: {},
    params: {},
    query: {},
    headers: {},
};
const mockNext = () => { };

// Mock Models
const mockModel = {
    find: () => ({ sort: () => ({ limit: () => ({ skip: () => ({ lean: () => Promise.resolve([]) }) }) }) }),
    findOne: () => ({ sort: () => Promise.resolve(null) }),
    findById: () => Promise.resolve(null),
    create: () => Promise.resolve({}),
    countDocuments: () => Promise.resolve(0),
};

// We can catch import errors
const checkFile = async (path) => {
    try {
        await import(path);
        console.log(`✅ ${path} loaded successfully`);
    } catch (e) {
        console.error(`❌ ${path} failed to load:`, e.message);
        process.exit(1);
    }
};

const run = async () => {
    console.log("Verifying admin routes...");

    const files = [
        '../src/routes/admin.orders.routes.js',
        '../src/routes/admin.products.routes.js',
        '../src/routes/admin.routes.js',
        '../src/routes/categories.routes.js',
        '../src/routes/admin.home-layout.routes.js',
        '../src/routes/admin.settings.routes.js',
        '../src/routes/admin.content.routes.js',
        '../src/routes/admin.media.routes.js',
        '../src/routes/admin.product-attributes.routes.js',
        '../src/routes/admin.returns.routes.js',
        '../src/routes/admin.audit.routes.js',
        '../src/routes/admin.users.routes.js',
        '../src/routes/admin.reviews.routes.js'
    ];

    for (const f of files) {
        await checkFile(f);
    }

    console.log("All admin routes verified successfully.");
};

run();
