
import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);

app.use(express.json());

const PORT = process.env.PORT || 5000;

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is missing from server .env");
}

const client = new MongoClient(process.env.MONGODB_URI);
const db = client.db("studiospace");

const studioCollection = db.collection("studios");
const bookingCollection = db.collection("bookings");
const profileCollection = db.collection("profiles");

let connectionPromise = null;

async function connectToMongoDB() {
  if (!connectionPromise) {
    connectionPromise = client.connect().catch((error) => {
      connectionPromise = null;
      throw error;
    });
  }

  return connectionPromise;
}

// Database connection middleware
app.use(async (req, res, next) => {
  try {
    await connectToMongoDB();
    next();
  } catch (error) {
    console.error("MongoDB connection failed:", error);

    return res.status(500).json({
      success: false,
      message: "Database connection failed.",
    });
  }
});

// Response helpers
function sendSuccess(res, data, message = "Success", status = 200) {
  return res.status(status).json({
    success: true,
    message,
    data,
  });
}

function sendError(res, message, status = 400) {
  return res.status(status).json({
    success: false,
    message,
  });
}

// Authentication
async function getAuthenticatedUser(req) {
  try {
    const cookie = req.headers.cookie;

    if (!cookie) return null;

    const authURL = (
      process.env.BETTER_AUTH_URL || "http://localhost:3000"
    ).replace(/\/$/, "");

    const response = await fetch(
      `${authURL}/api/auth/get-session`,
      {
        method: "GET",
        headers: {
          Cookie: cookie,
          Accept: "application/json",
        },
      }
    );

    if (!response.ok) return null;

    const result = await response.json();

    if (!result?.user || !result?.session) return null;

    return result.user;
  } catch (error) {
    console.error("Session verification failed:", error.message);
    return null;
  }
}

async function requireAuth(req, res) {
  const user = await getAuthenticatedUser(req);

  if (!user) {
    sendError(res, "Please login first.", 401);
    return null;
  }

  req.user = user;
  return user;
}

// Automatically calculate completed booking status when reading.
function getBookingStatus(booking) {
  if (booking.status === "cancelled") return "cancelled";

  if (new Date(booking.endAt) <= new Date()) {
    return "completed";
  }

  // Compatibility with bookings created before this update.
  if (booking.status === "upcoming") {
    return "confirmed";
  }

  return booking.status;
}

function formatBooking(booking) {
  return {
    ...booking,
    _id: booking._id.toString(),
    id: booking._id.toString(),
    status: getBookingStatus(booking),
  };
}



















app.get("/api/categories", (req, res) => {
  return sendSuccess(res, categories, "Categories fetched.");
});

// Get all studios
app.get("/api/studios", async (req, res) => {
  try {
    const { search, category, location, limit } = req.query;

    const filter = { status: "active" };

    if (category) filter.category = category;

    if (location) {
      filter.location = {
        $regex: String(location),
        $options: "i",
      };
    }

    if (search) {
      filter.$or = [
        { name: { $regex: String(search), $options: "i" } },
        { description: { $regex: String(search), $options: "i" } },
        { location: { $regex: String(search), $options: "i" } },
      ];
    }

    let query = studioCollection.find(filter).sort({ createdAt: -1 });

    const parsedLimit = Number(limit);

    if (Number.isInteger(parsedLimit) && parsedLimit > 0) {
      query = query.limit(Math.min(parsedLimit, 100));
    }

    const studios = await query.toArray();

    const formattedStudios = studios.map((studio) => ({
      ...studio,
      _id: studio._id.toString(),
    }));

    return sendSuccess(
      res,
      formattedStudios,
      "Studios fetched successfully."
    );
  } catch (error) {
    console.error("Failed to fetch studios:", error);
    return sendError(res, "Failed to fetch studios.", 500);
  }
});

// Host's own studio listings
app.get("/api/studios/my-listings", async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const studios = await studioCollection
      .find({ hostId: user.id })
      .sort({ createdAt: -1 })
      .toArray();

    const formattedStudios = studios.map((studio) => ({
      ...studio,
      _id: studio._id.toString(),
    }));

    return sendSuccess(res, formattedStudios);
  } catch (error) {
    console.error("Failed to fetch listings:", error);
    return sendError(res, "Failed to fetch your listings.", 500);
  }
});

// Get one studio
app.get("/api/studios/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return sendError(res, "Invalid studio ID.", 400);
    }

    const studio = await studioCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!studio) {
      return sendError(res, "Studio not found.", 404);
    }

    return sendSuccess(res, {
      ...studio,
      _id: studio._id.toString(),
    });
  } catch (error) {
    console.error("Failed to fetch studio:", error);
    return sendError(res, "Failed to fetch studio.", 500);
  }
});

// Add studio
app.post("/api/studios", async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const {
      name,
      category,
      location,
      image,
      pricePerHour,
      capacity,
      description,
      amenities,
    } = req.body;

    const price = Number(pricePerHour);

    const guestCapacity =
      capacity === "" || capacity === null || capacity === undefined
        ? null
        : Number(capacity);

    if (
      typeof name !== "string" ||
      !name.trim() ||
      typeof category !== "string" ||
      !category.trim() ||
      typeof location !== "string" ||
      !location.trim() ||
      typeof description !== "string" ||
      !description.trim() ||
      !Number.isFinite(price) ||
      price <= 0
    ) {
      return sendError(res, "Please provide valid studio details.");
    }

    if (
      guestCapacity !== null &&
      (!Number.isInteger(guestCapacity) || guestCapacity < 1)
    ) {
      return sendError(res, "Please provide a valid capacity.");
    }

    if (
      image &&
      (typeof image !== "string" || !/^https?:\/\//i.test(image.trim()))
    ) {
      return sendError(res, "Please provide a valid image URL.");
    }

    if (
      amenities !== undefined &&
      (!Array.isArray(amenities) ||
        !amenities.every((item) => typeof item === "string"))
    ) {
      return sendError(res, "Invalid amenities.");
    }

    const studio = {
      name: name.trim(),
      category: category.trim(),
      location: location.trim(),
      image: typeof image === "string" ? image.trim() : "",
      pricePerHour: price,
      capacity: guestCapacity,
      description: description.trim(),
      amenities: Array.isArray(amenities) ? amenities : [],
      hostId: user.id,
      hostEmail: user.email,
      hostName: user.name || "",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await studioCollection.insertOne(studio);

    return sendSuccess(
      res,
      {
        ...studio,
        _id: result.insertedId.toString(),
      },
      "Studio published successfully!",
      201
    );
  } catch (error) {
    console.error("Failed to add studio:", error);
    return sendError(res, "Failed to publish studio.", 500);
  }
});

// Update studio
app.put("/api/studios/:id", async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return sendError(res, "Invalid studio ID.");
    }

    const existingStudio = await studioCollection.findOne({
      _id: new ObjectId(id),
      hostId: user.id,
    });

    if (!existingStudio) {
      return sendError(
        res,
        "Studio not found or you do not have permission.",
        404
      );
    }

    const allowedFields = [
      "name",
      "category",
      "location",
      "image",
      "pricePerHour",
      "capacity",
      "description",
      "amenities",
    ];

    const update = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        update[field] = req.body[field];
      }
    }

    if (
      update.name !== undefined &&
      (typeof update.name !== "string" || !update.name.trim())
    ) {
      return sendError(res, "Studio name is required.");
    }

    if (
      update.pricePerHour !== undefined &&
      (!Number.isFinite(Number(update.pricePerHour)) ||
        Number(update.pricePerHour) <= 0)
    ) {
      return sendError(res, "Invalid hourly price.");
    }

    if (update.pricePerHour !== undefined) {
      update.pricePerHour = Number(update.pricePerHour);
    }

    if (update.capacity !== undefined) {
      if (update.capacity === "" || update.capacity === null) {
        update.capacity = null;
      } else {
        update.capacity = Number(update.capacity);

        if (
          !Number.isInteger(update.capacity) ||
          update.capacity < 1
        ) {
          return sendError(res, "Invalid studio capacity.");
        }
      }
    }

    if (
      update.amenities !== undefined &&
      (!Array.isArray(update.amenities) ||
        !update.amenities.every((item) => typeof item === "string"))
    ) {
      return sendError(res, "Invalid amenities.");
    }

    if (update.image !== undefined) {
      if (
        typeof update.image !== "string" ||
        (update.image.trim() &&
          !/^https?:\/\//i.test(update.image.trim()))
      ) {
        return sendError(res, "Invalid image URL.");
      }

      update.image = update.image.trim();
    }

    for (const field of ["name", "category", "location", "description"]) {
      if (update[field] !== undefined) {
        if (typeof update[field] !== "string" || !update[field].trim()) {
          return sendError(res, `${field} is required.`);
        }

        update[field] = update[field].trim();
      }
    }

    update.updatedAt = new Date();

    await studioCollection.updateOne(
      { _id: new ObjectId(id), hostId: user.id },
      { $set: update }
    );

    const updatedStudio = await studioCollection.findOne({
      _id: new ObjectId(id),
    });

    return sendSuccess(
      res,
      { ...updatedStudio, _id: updatedStudio._id.toString() },
      "Studio updated successfully."
    );
  } catch (error) {
    console.error("Failed to update studio:", error);
    return sendError(res, "Failed to update studio.", 500);
  }
});

// Delete studio
app.delete("/api/studios/:id", async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return sendError(res, "Invalid studio ID.");
    }

    const result = await studioCollection.deleteOne({
      _id: new ObjectId(id),
      hostId: user.id,
    });

    if (result.deletedCount === 0) {
      return sendError(
        res,
        "Studio not found or you do not have permission.",
        404
      );
    }

    return sendSuccess(res, null, "Studio deleted successfully.");
  } catch (error) {
    console.error("Failed to delete studio:", error);
    return sendError(res, "Failed to delete studio.", 500);
  }
});

// Create booking
app.post("/api/bookings", async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { studioId, date, startTime, hours, guests } = req.body;

    if (
      typeof studioId !== "string" ||
      !ObjectId.isValid(studioId)
    ) {
      return sendError(res, "Invalid studio ID.");
    }

    if (
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      typeof startTime !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)
    ) {
      return sendError(res, "Please provide a valid date and time.");
    }

    const duration = Number(hours);
    const guestCount = Number(guests);

    if (
      !Number.isInteger(duration) ||
      duration < 1 ||
      duration > 24 ||
      !Number.isInteger(guestCount) ||
      guestCount < 1
    ) {
      return sendError(res, "Invalid booking duration or guest count.");
    }

    const studio = await studioCollection.findOne({
      _id: new ObjectId(studioId),
      status: "active",
    });

    if (!studio) {
      return sendError(res, "Studio not found or unavailable.", 404);
    }

    if (studio.hostId === user.id) {
      return sendError(res, "You cannot book your own studio.");
    }

    if (studio.capacity && guestCount > Number(studio.capacity)) {
      return sendError(
        res,
        `This studio allows a maximum of ${studio.capacity} guests.`
      );
    }

    // Bangladesh time (UTC+6)
    const bookingStart = new Date(`${date}T${startTime}:00+06:00`);

    if (
      Number.isNaN(bookingStart.getTime()) ||
      bookingStart <= new Date()
    ) {
      return sendError(res, "Please select a future date and time.");
    }

    const bookingEnd = new Date(
      bookingStart.getTime() + duration * 60 * 60 * 1000
    );

    // Pending bookings are requests. Only confirmed bookings block a slot.
    const conflictingBooking = await bookingCollection.findOne({
      studioId,
      status: "confirmed",
      startAt: { $lt: bookingEnd },
      endAt: { $gt: bookingStart },
    });

    if (conflictingBooking) {
      return sendError(
        res,
        "This studio is already confirmed for that time."
      );
    }

    const hourlyPrice = Number(studio.pricePerHour);
    const totalPrice = hourlyPrice * duration;

    const booking = {
      userId: user.id,
      userEmail: user.email,
      studioId,
      studioName: studio.name,
      location: studio.location,
      studioImage: studio.image || "",
      date,
      startTime,
      hours: duration,
      guests: guestCount,
      hourlyPrice,
      totalPrice,
      startAt: bookingStart,
      endAt: bookingEnd,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await bookingCollection.insertOne(booking);

    return sendSuccess(
      res,
      {
        ...booking,
        _id: result.insertedId.toString(),
        id: result.insertedId.toString(),
      },
      "Booking request submitted successfully!",
      201
    );
  } catch (error) {
    console.error("Failed to create booking:", error);
    return sendError(res, "Failed to create booking.", 500);
  }
});

// My bookings
app.get("/api/bookings/my-bookings", async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const bookings = await bookingCollection
      .find({ userId: user.id })
      .sort({ createdAt: -1 })
      .toArray();

    return sendSuccess(res, bookings.map(formatBooking));
  } catch (error) {
    console.error("Failed to fetch bookings:", error);
    return sendError(res, "Failed to fetch bookings.", 500);
  }
});

// Host bookings
app.get("/api/bookings/host-bookings", async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const myStudios = await studioCollection
      .find(
        { hostId: user.id },
        { projection: { _id: 1 } }
      )
      .toArray();

    const studioIds = myStudios.map((studio) =>
      studio._id.toString()
    );

    if (studioIds.length === 0) {
      return sendSuccess(res, []);
    }

    const bookings = await bookingCollection
      .find({ studioId: { $in: studioIds } })
      .sort({ createdAt: -1 })
      .toArray();

    return sendSuccess(res, bookings.map(formatBooking));
  } catch (error) {
    console.error("Failed to fetch host bookings:", error);
    return sendError(res, "Failed to fetch host bookings.", 500);
  }
});

// User cancels own pending booking
app.patch("/api/bookings/:id/cancel", async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return sendError(res, "Invalid booking ID.");
    }

    const booking = await bookingCollection.findOne({
      _id: new ObjectId(id),
      userId: user.id,
    });

    if (!booking) {
      return sendError(res, "Booking not found.", 404);
    }

    if (booking.status !== "pending") {
      return sendError(
        res,
        "Only pending bookings can be cancelled."
      );
    }

    if (new Date(booking.endAt) <= new Date()) {
      return sendError(res, "This booking can no longer be cancelled.");
    }

    const result = await bookingCollection.updateOne(
      {
        _id: new ObjectId(id),
        userId: user.id,
        status: "pending",
      },
      {
        $set: {
          status: "cancelled",
          updatedAt: new Date(),
        },
      }
    );

    if (result.modifiedCount === 0) {
      return sendError(
        res,
        "Booking status has changed. Please refresh."
      );
    }

    return sendSuccess(res, null, "Booking cancelled successfully.");
  } catch (error) {
    console.error("Failed to cancel booking:", error);
    return sendError(res, "Failed to cancel booking.", 500);
  }
});

// Host confirms or cancels a pending booking
app.patch("/api/bookings/:id/status", async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { id } = req.params;
    const { status } = req.body;

    if (!ObjectId.isValid(id)) {
      return sendError(res, "Invalid booking ID.");
    }

    if (!["confirmed", "cancelled"].includes(status)) {
      return sendError(res, "Invalid booking status.");
    }

    const booking = await bookingCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!booking) {
      return sendError(res, "Booking not found.", 404);
    }

    const studio = await studioCollection.findOne({
      _id: new ObjectId(booking.studioId),
      hostId: user.id,
    });

    if (!studio) {
      return sendError(
        res,
        "You are not authorized to manage this booking.",
        403
      );
    }

    if (booking.status !== "pending") {
      return sendError(
        res,
        "Only pending bookings can be updated."
      );
    }

    if (new Date(booking.endAt) <= new Date()) {
      return sendError(res, "This booking has already expired.");
    }

    if (status === "confirmed") {
      const conflictingBooking = await bookingCollection.findOne({
        _id: { $ne: new ObjectId(id) },
        studioId: booking.studioId,
        status: "confirmed",
        startAt: { $lt: new Date(booking.endAt) },
        endAt: { $gt: new Date(booking.startAt) },
      });

      if (conflictingBooking) {
        return sendError(
          res,
          "Another confirmed booking already occupies this time."
        );
      }
    }

    const result = await bookingCollection.updateOne(
      {
        _id: new ObjectId(id),
        status: "pending",
      },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
      }
    );

    if (result.modifiedCount === 0) {
      return sendError(
        res,
        "Booking status has changed. Please refresh."
      );
    }

    return sendSuccess(
      res,
      { bookingId: id, status },
      status === "confirmed"
        ? "Booking confirmed successfully."
        : "Booking cancelled successfully."
    );
  } catch (error) {
    console.error("Failed to update host booking:", error);
    return sendError(res, "Failed to update booking.", 500);
  }
});

// Delete own booking
app.delete("/api/bookings/:id", async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return sendError(res, "Invalid booking ID.");
    }

    const result = await bookingCollection.deleteOne({
      _id: new ObjectId(id),
      userId: user.id,
    });

    if (result.deletedCount === 0) {
      return sendError(res, "Booking not found.", 404);
    }

    return sendSuccess(res, null, "Booking deleted successfully.");
  } catch (error) {
    console.error("Failed to delete booking:", error);
    return sendError(res, "Failed to delete booking.", 500);
  }
});

// Get profile
app.get("/api/profile", async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const profile = await profileCollection.findOne({
      userId: user.id,
    });

    return sendSuccess(res, {
      name: profile?.name ?? user.name ?? "",
      email: user.email ?? "",
      image: profile?.image ?? user.image ?? "",
      phone: profile?.phone ?? "",
      city: profile?.city ?? "",
      bio: profile?.bio ?? "",
      createdAt: user.createdAt ?? null,
    });
  } catch (error) {
    console.error("Failed to fetch profile:", error);
    return sendError(res, "Failed to fetch profile.", 500);
  }
});

// Update profile
app.patch("/api/profile", async (req, res) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const allowedFields = ["name", "image", "phone", "city", "bio"];
    const update = {};

    for (const field of allowedFields) {
      if (typeof req.body[field] === "string") {
        update[field] = req.body[field].trim();
      }
    }

    if (update.name !== undefined && !update.name) {
      return sendError(res, "Name cannot be empty.");
    }

    if (update.name && update.name.length > 100) {
      return sendError(res, "Name is too long.");
    }

    if (update.bio && update.bio.length > 500) {
      return sendError(res, "Bio must be 500 characters or fewer.");
    }

    if (
      update.image &&
      !/^https?:\/\//i.test(update.image)
    ) {
      return sendError(res, "Please provide a valid image URL.");
    }

    await profileCollection.updateOne(
      { userId: user.id },
      {
        $set: {
          ...update,
          userId: user.id,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    const profile = await profileCollection.findOne({
      userId: user.id,
    });

    return sendSuccess(
      res,
      {
        name: profile?.name ?? user.name ?? "",
        email: user.email ?? "",
        image: profile?.image ?? user.image ?? "",
        phone: profile?.phone ?? "",
        city: profile?.city ?? "",
        bio: profile?.bio ?? "",
        createdAt: user.createdAt ?? null,
      },
      "Profile updated successfully."
    );
  } catch (error) {
    console.error("Failed to update profile:", error);
    return sendError(res, "Failed to update profile.", 500);
  }
});

// API home
app.get("/", async (req, res) => {
  try {
    const allStudios = await studioCollection
      .find({ status: "active" })
      .sort({ createdAt: -1 })
      .toArray();

    const formattedStudios = allStudios.map((studio) => ({
      ...studio,
      _id: studio._id.toString(),
    }));

    return res.status(200).json({
      success: true,
      message: "StudioSpace API data fetched successfully!",
      categories,
      studios: formattedStudios,
      totalCategories: categories.length,
      totalStudios: formattedStudios.length,
    });
  } catch (error) {
    console.error("Failed to fetch main API data:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch StudioSpace API data.",
    });
  }
});

// Start server
async function run() {
  try {
    await connectToMongoDB();

    console.log("Database connected:", db.databaseName);
    console.log("MongoDB Atlas connected successfully!");

    app.listen(PORT, () => {
      console.log(`StudioSpace server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

run();

export default app;
