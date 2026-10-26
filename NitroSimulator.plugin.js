/**
 * @name NitroSimulator
 * @author ce017
 * @authorLink https://github.com/ce017
 * @description Equip any avatar decoration, profile effect, nameplate, profile frame, banner, display name style and badge (at any level, in any order) on your own profile, straight from Discord's own catalog. Client-side only: nobody else can see it.
 * @version 1.1.0
 * @source https://github.com/ce017/NitroSimulator
 * @updateUrl https://raw.githubusercontent.com/ce017/NitroSimulator/main/NitroSimulator.plugin.js
 */

const PLUGIN = "NitroSimulator";
const { React, ReactDOM, Webpack, Data, Patcher, DOM, UI, Components } = new BdApi(PLUGIN);
const { Filters } = Webpack;
const h = React.createElement;

const UserStore = Webpack.getStore("UserStore");
const UserProfileStore = Webpack.getStore("UserProfileStore");

// Several of these live in chunks Discord only loads on demand (the profile editor, the shop, the badge directory),
// so they are looked up when first needed and cached once found.
function lazy(find) {
    let value;
    return () => value ?? (value = find());
}
const findFunction = (...strings) => Webpack.getModule(Filters.byStrings(...strings), { searchExports: true });
const getBadgeDirectoryStore = lazy(() => Webpack.getStore("BadgeDirectoryStore"));
const getCollectiblesStore = lazy(() => Webpack.getStore("CollectiblesCategoryStore"));
const getFetchShopCatalog = lazy(() => findFunction("COLLECTIBLES_CATEGORIES_FETCH", "COLLECTIBLES_CATEGORIES_V2"));
const getFetchBadgeCatalog = lazy(() => findFunction("BADGE_DIRECTORY_FETCH_START"));
const getProfileFrame = lazy(() => findFunction("filterLayer", "profileFrameClassName"));
const getFetchProfile = lazy(() => findFunction("USER_PROFILE_FETCH_START", "withMutualFriends"));
const editorClassesFilter = Filters.byKeys("editingPanel", "profileContentOuter");

// Display name styles: Discord's font/effect enums, its preset colour palettes and the component that draws a styled name.
const unwrapComponent = m => m?.render ?? m?.type?.render ?? m?.type ?? m;
const getNameFonts = lazy(() => Webpack.getModule(m => m?.CHERRY_BOMB !== undefined && m?.HEXAGON !== undefined, { searchExports: true }));
const getNameEffects = lazy(() => Webpack.getModule(m => m?.GRADIENT === 2 && m?.GUMMY !== undefined, { searchExports: true }));
const getNameFontInfo = lazy(() => {
    const mod = Webpack.getBySource("useDisplayNameStylesFont");
    return mod && Object.values(mod).find(f => typeof f === "function" && f.toString().includes("className:"));
});
const getNamePalettes = lazy(() => {
    const mod = Webpack.getBySource("2417517");
    return mod && Object.values(mod).find(f => typeof f === "function" && f.length === 1 && f.toString().includes("switch"));
});
const getStyledName = lazy(() => Webpack.getModule(m => {
    const f = unwrapComponent(m);
    return typeof f === "function" && f.toString().includes("data-username-with-effects");
}, { searchExports: true }));
const getNameDisplayType = lazy(() => Webpack.getModule(m => m?.ANIMATED !== undefined && m?.PLAIN !== undefined && m?.STATIC !== undefined, { searchExports: true }));

// Stands in for a banner hash on your profile; the banner URL builder swaps it for your picked image.
const BANNER_SENTINEL = "ns_banner";
const MAX_BANNER_FILE = 10 * 1024 * 1024;

// Discord's badge type enum ({ PREMIUM_TENURE: 1, ..., STAFF: 22 }), with a copy as fallback.
const BadgeType = Webpack.getModule(m => m?.PREMIUM_TENURE === 1 && m?.GUILD_BOOSTER === 12, { searchExports: true }) ?? {
    1: "PREMIUM_TENURE", 2: "PARTNER", 3: "CERTIFIED_MODERATOR", 4: "HYPESQUAD", 5: "HYPESQUAD_HOUSE_1",
    6: "HYPESQUAD_HOUSE_2", 7: "HYPESQUAD_HOUSE_3", 8: "BUG_HUNTER_LEVEL_1", 9: "BUG_HUNTER_LEVEL_2",
    10: "VERIFIED_DEVELOPER", 11: "EARLY_SUPPORTER", 12: "GUILD_BOOSTER", 13: "LEGACY_USERNAME",
    14: "QUEST_COMPLETED", 15: "APRIL_FOOLS_2026", 16: "ORB_PROFILE", 17: "GIFTING", 18: "ACCOUNT_AGE",
    19: "STREAMING", 20: "GAME_TIME", 21: "GAME_VARIETY", 22: "STAFF"
};
const PREMIUM_TENURE = 1;
const GUILD_BOOSTER = 12;
const ORB_PROFILE = 16;

// The Nitro badge's tiers (Starter → Opal) map onto these profile badge ids, in order.
const NITRO_TIER_IDS = [
    "premium", "premium_tenure_1_month_v2", "premium_tenure_3_month_v2", "premium_tenure_6_month_v2",
    "premium_tenure_12_month_v2", "premium_tenure_24_month_v2", "premium_tenure_36_month_v2",
    "premium_tenure_60_month_v2", "premium_tenure_72_month_v2"
];

// Same order Discord lists badges in (staff first, then the levelled activity badges, then the classic ones).
const BADGE_ORDER = [22, 21, 20, 19, 18, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];

const CollectibleType = { DECORATION: 0, EFFECT: 1, NAMEPLATE: 2, FRAME: 3 };

const TABS = [
    { id: "decoration", label: "Decorations", type: CollectibleType.DECORATION },
    { id: "effect", label: "Profile Effects", type: CollectibleType.EFFECT },
    { id: "nameplate", label: "Nameplates", type: CollectibleType.NAMEPLATE },
    { id: "frame", label: "Profile Frames", type: CollectibleType.FRAME },
    { id: "banner", label: "Banner" },
    { id: "nameStyle", label: "Name Style" },
    { id: "badges", label: "Badges" }
];

const DEFAULT_SETTINGS = {
    decoration: null, effect: null, nameplate: null, frame: null, banner: null, nameStyle: null,
    badges: [], keepRealBadges: true, badgeOrder: null
};

const decorationUrl = (asset, animated) => `https://cdn.discordapp.com/avatar-decoration-presets/${asset}.png?size=160&passthrough=${animated}`;
const nameplateUrl = (asset, animated) => `https://cdn.discordapp.com/assets/collectibles/${asset}${animated ? "asset.webm" : "static.png"}`;

function badgeTypeOf(profileBadgeId) {
    if (profileBadgeId === "premium" || profileBadgeId.startsWith("premium_tenure_")) return PREMIUM_TENURE;
    if (profileBadgeId.startsWith("guild_booster_lvl")) return GUILD_BOOSTER;
    if (profileBadgeId === "orb_profile_badge") return ORB_PROFILE;
    if (profileBadgeId === "staff" || profileBadgeId.startsWith("staff_")) return 22;
    const type = BadgeType[profileBadgeId.toUpperCase()];
    return typeof type === "number" ? type : null;
}

function profileBadgeId(badgeId, tierIndex) {
    if (badgeId === PREMIUM_TENURE) return NITRO_TIER_IDS[tierIndex] ?? "premium";
    if (badgeId === GUILD_BOOSTER) return `guild_booster_lvl${tierIndex + 1}`;
    if (badgeId === ORB_PROFILE) return "orb_profile_badge";
    return BadgeType[badgeId]?.toLowerCase() ?? `badge_${badgeId}`;
}

function tierLabel(tier, index) {
    const name = tier.name || `Level ${index + 1}`;
    return tier.milestone_text && tier.milestone_text !== name ? `${name} (${tier.milestone_text})` : name;
}

// Everything the profile needs is captured at equip time, so the badge still renders without the catalog loaded.
function snapshotBadge(badge, tierKey) {
    const tierIndex = badge.tiers?.findIndex(t => t.key === tierKey) ?? -1;
    const tier = tierIndex >= 0 ? badge.tiers[tierIndex] : null;
    const id = profileBadgeId(badge.badge_id, Math.max(tierIndex, 0));
    return {
        badgeId: badge.badge_id,
        tier: tier?.key ?? null,
        profile: {
            id,
            icon: id,
            iconSrc: tier?.simple_icon_raster_url ?? badge.simple_icon_raster_url,
            description: tier ? `${badge.name}: ${tierLabel(tier, tierIndex)}` : badge.name
        }
    };
}

// Copies every own property (Discord's records keep some methods as non-enumerable own fields) and applies overrides.
function cloneWith(source, overrides) {
    const clone = Object.create(Object.getPrototypeOf(source), Object.getOwnPropertyDescriptors(source));
    for (const [key, value] of Object.entries(overrides)) {
        Object.defineProperty(clone, key, { value, writable: true, enumerable: true, configurable: true });
    }
    return clone;
}

// Identifies a badge for ordering, so a Nitro badge keeps its place whichever level it is.
function badgeKey(badge) {
    return String(badgeTypeOf(badge.id) ?? badge.id);
}

// Your custom order first (if any), then Discord's usual order for anything not in it.
function sortBadges(badges, customOrder) {
    const rank = b => {
        const custom = customOrder?.indexOf(badgeKey(b)) ?? -1;
        if (custom !== -1) return custom;
        const i = BADGE_ORDER.indexOf(badgeTypeOf(b.id));
        return (customOrder?.length ?? 0) + (i === -1 ? BADGE_ORDER.length : i);
    };
    return [...badges].sort((a, b) => rank(a) - rank(b));
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

const hexToInt = hex => parseInt(hex.slice(1), 16);
const intToHex = n => `#${(n >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
const titleCase = key => key.toLowerCase().split("_").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");

module.exports = class NitroSimulator {
    constructor() {
        this.settings = { ...DEFAULT_SETTINGS };
        this.revision = 0;
        this.userClones = new WeakMap();
        this.profileClones = new WeakMap();
        this.listeners = new Set();
        this.readingCatalog = false;
    }

    start() {
        this.settings = { ...DEFAULT_SETTINGS, ...Data.load("settings") };
        this.currentUserId = UserStore.getCurrentUser()?.id;
        DOM.addStyle(STYLES);
        this.patchUsers();
        this.patchProfiles();
        this.refresh();

        this.abort = new AbortController();
        const { signal } = this.abort;
        this.waitFor(Filters.byStoreName("BadgeDirectoryStore"), signal, store => {
            this.patchBadgeDirectory(store);
            store.emitChange();
        });
        this.waitFor(editorClassesFilter, signal, classes => {
            this.editorClasses = classes;
            this.injectIntoProfileEditor();
        });
        this.waitFor(Filters.bySource("/banners/${"), signal, module => this.patchBannerUrl(module));
    }

    // Runs `then` with the module as soon as Discord loads it (straight away if it already has).
    waitFor(filter, signal, then) {
        Webpack.waitForModule(filter, { signal })
            .then(module => { if (module && !signal.aborted) then(module); })
            .catch(err => { if (!signal.aborted) console.error(`[${PLUGIN}]`, err); });
    }

    stop() {
        this.abort?.abort();
        Patcher.unpatchAll();
        DOM.removeStyle();
        document.querySelectorAll(".ns-section").forEach(el => el.remove());
        this.revision++;
        this.emitStoreChanges();
    }

    // The editor panel's groups render after the panel itself, so check again once per frame while the DOM changes.
    observer() {
        if (!this.editorClasses || this.injectQueued) return;
        this.injectQueued = true;
        requestAnimationFrame(() => {
            this.injectQueued = false;
            this.injectIntoProfileEditor();
        });
    }

    getSettingsPanel() {
        return h(Picker, { plugin: this });
    }

    // ---- state ----

    update(changes) {
        this.settings = { ...this.settings, ...changes };
        Data.save("settings", this.settings);
        this.refresh();
    }

    refresh() {
        this.revision++;
        this.emitStoreChanges();
        this.listeners.forEach(fn => fn());
    }

    emitStoreChanges() {
        for (const store of [UserStore, UserProfileStore, getBadgeDirectoryStore()]) {
            try { store?.emitChange(); } catch (err) { console.error(`[${PLUGIN}]`, err); }
        }
    }

    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    // ---- patches ----

    patchUsers() {
        Patcher.after(UserStore, "getCurrentUser", (_, __, user) => {
            if (user) this.currentUserId = user.id;
            return this.dressUser(user);
        });
        Patcher.after(UserStore, "getUser", (_, __, user) => this.dressUser(user));
    }

    dressUser(user) {
        const { decoration, nameplate, nameStyle } = this.settings;
        if (!user || user.id !== this.currentUserId || (!decoration && !nameplate && !nameStyle)) return user;

        const cached = this.userClones.get(user);
        if (cached?.revision === this.revision) return cached.clone;

        const overrides = {};
        if (decoration) overrides.avatarDecorationData = { asset: decoration.asset, skuId: decoration.skuId, expiresAt: null };
        if (nameplate) {
            overrides.collectibles = {
                ...user.collectibles,
                nameplate: { skuId: nameplate.skuId, asset: nameplate.asset, label: nameplate.label, palette: nameplate.palette, expiresAt: null }
            };
        }
        if (nameStyle) overrides.displayNameStyles = { fontId: nameStyle.fontId, effectId: nameStyle.effectId, colors: nameStyle.colors };
        const clone = cloneWith(user, overrides);
        this.userClones.set(user, { revision: this.revision, clone });
        return clone;
    }

    patchProfiles() {
        Patcher.after(UserProfileStore, "getUserProfile", (_, [userId], profile) => {
            if (!profile || userId !== this.currentUserId) return profile;
            return this.dressProfile(profile);
        });
    }

    dressProfile(profile) {
        const { effect, frame, banner, badges, keepRealBadges, badgeOrder } = this.settings;
        if (!effect && !frame && !banner && !badges.length && keepRealBadges && !badgeOrder) return profile;

        const cached = this.profileClones.get(profile);
        if (cached?.revision === this.revision) return cached.clone;

        const equippedTypes = new Set(badges.map(b => b.badgeId));
        const real = keepRealBadges ? (profile.badges ?? []).filter(b => !equippedTypes.has(badgeTypeOf(b.id))) : [];
        const overrides = { badges: sortBadges([...real, ...badges.map(b => b.profile)], badgeOrder) };
        if (effect) overrides.profileEffect = { skuId: effect.skuId, expiresAt: null };
        if (frame) overrides.profileFrame = { skuId: frame.skuId, expiresAt: null };
        // Discord only draws banner images for Nitro profiles, so the profile also reports Nitro while a banner is picked.
        if (banner) {
            overrides.banner = BANNER_SENTINEL;
            overrides.premiumType = Math.max(profile.premiumType ?? 0, 2);
        }

        const clone = cloneWith(profile, overrides);
        this.profileClones.set(profile, { revision: this.revision, clone });
        return clone;
    }

    // Discord builds banner URLs from the profile's banner hash; for our stand-in hash it gets the picked image instead.
    patchBannerUrl(module) {
        const key = Object.keys(module).find(k => typeof module[k] === "function" && module[k].toString().includes("/banners/"));
        if (!key) return;
        Patcher.after(module, key, (_, [args], url) => {
            if (args?.banner !== BANNER_SENTINEL) return url;
            return this.settings.banner?.url ?? url;
        });
        UserProfileStore.emitChange();
    }

    // Discord's badge directory (click a badge on your profile) shows equipped badges as owned, at the chosen level.
    patchBadgeDirectory(BadgeDirectoryStore) {
        const dress = (badge, userId) => {
            if (!badge || this.readingCatalog || (userId ?? this.currentUserId) !== this.currentUserId) return badge;
            const equipped = this.settings.badges.find(b => b.badgeId === badge.badge_id);
            if (!equipped) return badge;
            return { ...badge, owned: true, hidden: false, current_tier: equipped.tier ?? badge.current_tier };
        };
        Patcher.after(BadgeDirectoryStore, "getBadges", (_, [userId], badges) => badges?.map(b => dress(b, userId)));
        Patcher.after(BadgeDirectoryStore, "getBadgeById", (_, [, userId], badge) => dress(badge, userId));
    }

    // Unpatched view of the badge catalog, for the picker.
    getBadgeCatalog() {
        this.readingCatalog = true;
        try { return getBadgeDirectoryStore()?.getBadges(this.currentUserId) ?? []; }
        finally { this.readingCatalog = false; }
    }

    // ---- profile editor section ----

    injectIntoProfileEditor() {
        if (!this.editorClasses) return;
        for (const panel of document.querySelectorAll(`.${this.editorClasses.editingPanel}`)) {
            if (panel.querySelector(".ns-section")) continue;
            const headings = panel.querySelectorAll("h3");
            const lastGroup = headings[headings.length - 1]?.parentElement;
            if (!lastGroup?.parentElement) continue;

            const container = document.createElement("div");
            container.className = `ns-section ${lastGroup.className}`;
            lastGroup.parentElement.appendChild(container);

            const root = ReactDOM.createRoot(container);
            root.render(h(Components.ErrorBoundary, null, h(EditorSection, { plugin: this, headingClass: headings[0].className })));
            DOM.onRemoved(container, () => root.unmount());
        }
    }

    openPicker(tab) {
        UI.showConfirmationModal("Nitro Simulator", h(Picker, { plugin: this, initialTab: tab }), {
            confirmText: "Done",
            cancelText: null,
            size: "large"
        });
    }
};

// ---- React components ----

function useSettings(plugin) {
    const [, force] = React.useReducer(n => n + 1, 0);
    React.useEffect(() => plugin.subscribe(force), [plugin]);
    return plugin.settings;
}

function useStore(store, read) {
    const [value, setValue] = React.useState(read);
    React.useEffect(() => {
        if (!store) return;
        const onChange = () => setValue(read());
        store.addChangeListener(onChange);
        return () => store.removeChangeListener(onChange);
    }, [store]);
    return value;
}

function useShopItems(type) {
    const store = getCollectiblesStore();
    const products = useStore(store, () => store?.products);
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => {
        const fetchShopCatalog = getFetchShopCatalog();
        if (products?.size || !fetchShopCatalog) return;
        setLoading(true);
        Promise.resolve(fetchShopCatalog()).catch(err => console.error(`[${PLUGIN}]`, err)).finally(() => setLoading(false));
    }, []);

    const items = React.useMemo(() => {
        const seen = new Set();
        const list = [];
        // Standalone products first, so an item is named after itself rather than a bundle it's part of.
        const ordered = [...products?.values() ?? []].sort((a, b) => (a.type === type ? 0 : 1) - (b.type === type ? 0 : 1));
        for (const product of ordered) {
            for (const item of product.items ?? []) {
                if (item.type !== type || seen.has(item.skuId)) continue;
                seen.add(item.skuId);
                list.push({ ...item, name: product.name });
            }
        }
        return list;
    }, [products, type]);

    return { items, loading };
}

function useBadgeCatalog(plugin) {
    const badges = useStore(getBadgeDirectoryStore(), () => plugin.getBadgeCatalog());
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => {
        const fetchBadgeCatalog = getFetchBadgeCatalog();
        if (badges.length || !fetchBadgeCatalog) return;
        setLoading(true);
        Promise.resolve(fetchBadgeCatalog()).catch(err => console.error(`[${PLUGIN}]`, err)).finally(() => setLoading(false));
    }, []);

    return { badges, loading };
}

function Picker({ plugin, initialTab = "decoration" }) {
    const [tab, setTab] = React.useState(initialTab);
    const current = TABS.find(t => t.id === tab);

    return h("div", { className: "ns-picker" },
        h("div", { className: "ns-note" }, "Client-side only: these show on your profile for you, and nobody else can see them."),
        h("div", { className: "ns-tabs", role: "tablist" },
            TABS.map(t => h("button", {
                key: t.id,
                role: "tab",
                "aria-selected": t.id === tab,
                className: `ns-tab ${t.id === tab ? "ns-active" : ""}`,
                onClick: () => setTab(t.id)
            }, t.label))
        ),
        tab === "badges" ? h(BadgePicker, { plugin })
            : tab === "banner" ? h(BannerPicker, { plugin })
            : tab === "nameStyle" ? h(NameStylePicker, { plugin })
            : h(CollectiblePicker, { key: tab, plugin, slot: tab, type: current.type })
    );
}

function BannerPicker({ plugin }) {
    const settings = useSettings(plugin);
    const [url, setUrl] = React.useState("");
    const [error, setError] = React.useState(null);
    const fileInput = React.useRef(null);
    const banner = settings.banner;

    // Load the image first so a broken link never ends up on the profile.
    const tryImage = (src, name) => new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = src;
    }).then(ok => {
        if (!ok) return setError("That image couldn't be loaded. Use a direct link to a PNG, JPG, GIF or WebP.");
        setError(null);
        plugin.update({ banner: { url: src, name } });
    });

    const onFile = async e => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        if (!file.type.startsWith("image/")) return setError("Pick an image file.");
        if (file.size > MAX_BANNER_FILE) return setError("That file is over 10 MB. Pick a smaller one.");
        tryImage(await readFileAsDataUrl(file), file.name);
    };

    return h("div", { className: "ns-banner" },
        h("div", { className: "ns-banner-preview" },
            banner ? h("img", { src: banner.url, alt: "" }) : h("span", null, "No banner picked: your real one shows.")
        ),
        h("div", { className: "ns-banner-row" },
            h("input", {
                className: "ns-search",
                placeholder: "Paste an image or GIF link",
                value: url,
                onChange: e => setUrl(e.target.value),
                onKeyDown: e => { if (e.key === "Enter" && url.trim()) tryImage(url.trim(), url.trim()); }
            }),
            h("button", { className: "ns-button", disabled: !url.trim(), onClick: () => tryImage(url.trim(), url.trim()) }, "Use link")
        ),
        h("div", { className: "ns-banner-row" },
            h("button", { className: "ns-button", onClick: () => fileInput.current?.click() }, "Upload from computer"),
            banner && h("button", { className: "ns-button ns-secondary", onClick: () => plugin.update({ banner: null }) }, "Remove"),
            h("input", { ref: fileInput, type: "file", accept: "image/*", hidden: true, onChange: onFile })
        ),
        error && h("div", { className: "ns-error" }, error),
        h("div", { className: "ns-note" }, "Animated GIFs work. Discord shows banners at about 5:2, so wide images look best.")
    );
}

const EFFECT_ORDER = ["SOLID", "GRADIENT", "NEON", "TOON", "POP", "GLOW", "PRISM", "GUMMY"];

function NameStylePicker({ plugin }) {
    const settings = useSettings(plugin);
    const fonts = getNameFonts();
    const effects = getNameEffects();
    const fontInfo = getNameFontInfo();
    const palettesFor = getNamePalettes();
    const me = UserStore.getCurrentUser();

    if (!fonts || !effects) {
        return h("div", { className: "ns-empty" }, "Discord's name styles aren't available in this client yet.");
    }

    const style = settings.nameStyle ?? { fontId: fonts.DEFAULT, effectId: effects.SOLID, colors: [0xffffff] };
    const palettes = (() => {
        try { return palettesFor?.(style.effectId) ?? [[0xffffff]]; }
        catch { return [[0xffffff]]; }
    })();
    const set = changes => plugin.update({ nameStyle: { ...style, ...changes } });

    // Fonts without a class name aren't loaded by this Discord build, so they'd fall back to the normal font.
    const fontList = Object.keys(fonts).filter(k => isNaN(k)).filter(k => k === "DEFAULT" || fontInfo?.(fonts[k])?.className);
    const effectList = EFFECT_ORDER.filter(k => effects[k] !== undefined);

    const pickEffect = key => {
        const next = effects[key];
        let preset = [[0xffffff]];
        try { preset = palettesFor?.(next) ?? preset; } catch {}
        set({ effectId: next, colors: [...preset[0]] });
    };

    return h("div", { className: "ns-namestyle" },
        h("div", { className: "ns-name-preview" },
            h(StyledName, { name: me?.globalName ?? me?.username ?? "You", style }),
            settings.nameStyle && h("button", { className: "ns-button ns-secondary", onClick: () => plugin.update({ nameStyle: null }) }, "Use my real one")
        ),
        h("div", { className: "ns-heading" }, "Font"),
        h("div", { className: "ns-chips" },
            fontList.map(key => h("button", {
                key,
                className: `ns-chip ${style.fontId === fonts[key] ? "ns-active" : ""}`,
                onClick: () => set({ fontId: fonts[key] })
            }, h("span", { className: fontInfo?.(fonts[key])?.className }, key === "DEFAULT" ? "Default" : titleCase(key))))
        ),
        h("div", { className: "ns-heading" }, "Effect"),
        h("div", { className: "ns-chips" },
            effectList.map(key => h("button", {
                key,
                className: `ns-chip ${style.effectId === effects[key] ? "ns-active" : ""}`,
                onClick: () => pickEffect(key)
            }, titleCase(key)))
        ),
        h("div", { className: "ns-heading" }, "Colours"),
        h("div", { className: "ns-chips" },
            palettes.map((colors, i) => h("button", {
                key: i,
                className: `ns-swatch ${colors.join() === style.colors.join() ? "ns-active" : ""}`,
                style: { background: colors.length > 1 ? `linear-gradient(90deg, ${colors.map(intToHex).join(", ")})` : intToHex(colors[0]) },
                onClick: () => set({ colors: [...colors] }),
                title: colors.map(intToHex).join(" ")
            }))
        ),
        h("div", { className: "ns-chips" },
            style.colors.map((color, i) => h("label", { key: i, className: "ns-color" },
                h("input", {
                    type: "color",
                    value: intToHex(color),
                    onChange: e => set({ colors: style.colors.map((c, j) => j === i ? hexToInt(e.target.value) : c) })
                }),
                style.colors.length > 1 ? `Colour ${i + 1}` : "Custom colour"
            ))
        )
    );
}

// Discord's own styled-name component, so the preview matches what the profile shows.
function StyledName({ name, style }) {
    const Component = getStyledName();
    const displayType = getNameDisplayType();
    if (!Component) return h("span", { className: "ns-name-fallback" }, name);
    return h(Components.ErrorBoundary, { fallback: h("span", { className: "ns-name-fallback" }, name) },
        h(Component, { userName: name, displayNameStyles: style, effectDisplayType: displayType?.ANIMATED ?? 2, inProfile: true, loop: true })
    );
}

const PAGE_SIZE = 90;

function CollectiblePicker({ plugin, slot, type }) {
    const settings = useSettings(plugin);
    const { items, loading } = useShopItems(type);
    const [query, setQuery] = React.useState("");
    const [shown, setShown] = React.useState(PAGE_SIZE);

    const filtered = React.useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return items;
        return items.filter(i => [i.name, i.label, i.title].some(s => s?.toLowerCase().includes(q)));
    }, [items, query]);

    const selected = settings[slot];
    const equip = item => plugin.update({ [slot]: item && toSetting(slot, item) });

    return h("div", null,
        h("input", {
            className: "ns-search",
            placeholder: `Search ${items.length} items`,
            value: query,
            onChange: e => { setQuery(e.target.value); setShown(PAGE_SIZE); }
        }),
        loading && !items.length && h("div", { className: "ns-empty" }, "Loading Discord's shop…"),
        !loading && !items.length && h("div", { className: "ns-empty" }, "Couldn't load the shop catalog. Open the Discord Shop once, then try again."),
        h("div", { className: `ns-grid ns-grid-${slot}` },
            h(Tile, { selected: !selected, onClick: () => equip(null), label: "None (use my real one)" },
                h("div", { className: "ns-none" }, "∅")
            ),
            filtered.slice(0, shown).map(item => h(Tile, {
                key: item.skuId,
                selected: selected?.skuId === item.skuId,
                onClick: () => equip(item),
                label: item.title ?? item.name
            }, h(Preview, { slot, item })))
        ),
        filtered.length > shown && h("button", { className: "ns-more", onClick: () => setShown(n => n + PAGE_SIZE) },
            `Show more (${filtered.length - shown} left)`)
    );
}

function toSetting(slot, item) {
    switch (slot) {
        case "decoration": return { skuId: item.skuId, asset: item.asset, label: item.label, name: item.name };
        case "nameplate": return { skuId: item.skuId, asset: item.asset, label: item.label, palette: item.palette, name: item.name };
        case "effect": return { skuId: item.skuId, name: item.title ?? item.name, thumbnail: item.thumbnailPreviewSrc };
        case "frame": return { skuId: item.skuId, name: item.name, label: item.label };
    }
}

function Tile({ selected, onClick, label, children }) {
    return h("button", { className: `ns-tile ${selected ? "ns-active" : ""}`, onClick, title: label },
        h("div", { className: "ns-thumb" }, children),
        h("div", { className: "ns-label" }, label)
    );
}

function Preview({ slot, item }) {
    const [hover, setHover] = React.useState(false);
    const events = { onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) };

    switch (slot) {
        case "decoration":
            return h("img", { ...events, src: decorationUrl(item.asset, hover), loading: "lazy", alt: item.label ?? "" });
        case "effect":
            return h("img", { src: item.thumbnailPreviewSrc, loading: "lazy", alt: item.accessibilityLabel ?? "" });
        case "nameplate":
            return hover
                ? h("video", { ...events, src: nameplateUrl(item.asset, true), autoPlay: true, loop: true, muted: true })
                : h("img", { ...events, src: nameplateUrl(item.asset, false), loading: "lazy", alt: item.label ?? "" });
        case "frame":
            return h(FramePreview, { item });
    }
    return null;
}

function FramePreview({ item }) {
    const ProfileFrame = getProfileFrame();
    if (!ProfileFrame) return h("div", { className: "ns-none" }, item.name);
    return h(Components.ErrorBoundary, { fallback: h("div", { className: "ns-none" }, item.name) },
        h("div", { className: "ns-frame" },
            h("div", { className: "ns-frame-card" }),
            h(ProfileFrame, { frame: item, fadeIn: false, isPreview: true })
        )
    );
}

function BadgePicker({ plugin }) {
    const settings = useSettings(plugin);
    const { badges, loading } = useBadgeCatalog(plugin);
    const equipped = new Map(settings.badges.map(b => [b.badgeId, b]));

    const setBadge = (badge, tierKey, on) => {
        const others = settings.badges.filter(b => b.badgeId !== badge.badge_id);
        plugin.update({ badges: on ? [...others, snapshotBadge(badge, tierKey)] : others });
    };

    return h("div", null,
        h(BadgeOrder, { plugin }),
        h("div", { className: "ns-row ns-row-head" },
            h("div", { className: "ns-row-text" },
                h("div", { className: "ns-row-name" }, "Keep my real badges"),
                h("div", { className: "ns-row-desc" }, "Off: your profile shows only the badges you equip here.")
            ),
            h(Components.SwitchInput, { value: settings.keepRealBadges, onChange: v => plugin.update({ keepRealBadges: v }) })
        ),
        loading && !badges.length && h("div", { className: "ns-empty" }, "Loading Discord's badge list…"),
        !loading && !badges.length && h("div", { className: "ns-empty" }, "Couldn't load the badge list from Discord."),
        badges.map(badge => {
            const mine = equipped.get(badge.badge_id);
            const tiers = badge.tiers ?? [];
            const tierKey = mine?.tier ?? badge.current_tier ?? tiers[tiers.length - 1]?.key ?? null;
            const tier = tiers.find(t => t.key === tierKey);
            return h("div", { key: badge.badge_id, className: `ns-row ${mine ? "ns-active" : ""}` },
                h("img", { className: "ns-badge-icon", src: tier?.simple_icon_raster_url ?? badge.simple_icon_raster_url, alt: "" }),
                h("div", { className: "ns-row-text" },
                    h("div", { className: "ns-row-name" }, badge.name, badge.owned && h("span", { className: "ns-owned" }, "you own this")),
                    badge.description && h("div", { className: "ns-row-desc" }, badge.description)
                ),
                tiers.length > 0 && h("div", { className: "ns-tier" },
                    h(Components.DropdownInput, {
                        value: tierKey,
                        options: tiers.map((t, i) => ({ label: tierLabel(t, i), value: t.key })),
                        onChange: key => setBadge(badge, key, true)
                    })
                ),
                h(Components.SwitchInput, { value: !!mine, onChange: on => setBadge(badge, tierKey, on) })
            );
        })
    );
}

// The badges exactly as your profile shows them; drag one onto another to move it there.
function BadgeOrder({ plugin }) {
    const settings = useSettings(plugin);
    const userId = plugin.currentUserId;
    const badges = useStore(UserProfileStore, () => UserProfileStore.getUserProfile(userId)?.badges ?? null);
    const [dragging, setDragging] = React.useState(null);

    React.useEffect(() => {
        if (badges == null) Promise.resolve(getFetchProfile()?.(userId)).catch(err => console.error(`[${PLUGIN}]`, err));
    }, []);

    const move = (from, to) => {
        if (from === to || !badges) return;
        const keys = badges.map(badgeKey);
        const [moved] = keys.splice(from, 1);
        keys.splice(to, 0, moved);
        plugin.update({ badgeOrder: keys });
    };

    return h("div", { className: "ns-order" },
        h("div", { className: "ns-order-head" },
            h("div", null,
                h("div", { className: "ns-row-name" }, "Badge order"),
                h("div", { className: "ns-row-desc" }, "Drag a badge to move it. This is the order on your profile.")
            ),
            settings.badgeOrder && h("button", { className: "ns-button ns-secondary", onClick: () => plugin.update({ badgeOrder: null }) }, "Reset order")
        ),
        badges == null
            ? h("div", { className: "ns-row-desc" }, "Loading your profile…")
            : h("div", { className: "ns-order-list" },
                badges.length === 0 && h("div", { className: "ns-row-desc" }, "No badges to order yet."),
                badges.map((badge, i) => h("div", {
                    key: badge.id,
                    className: `ns-order-item ${dragging === i ? "ns-dragging" : ""}`,
                    draggable: true,
                    title: badge.description,
                    onDragStart: e => { setDragging(i); e.dataTransfer.effectAllowed = "move"; },
                    onDragEnd: () => setDragging(null),
                    onDragOver: e => e.preventDefault(),
                    onDrop: e => { e.preventDefault(); if (dragging != null) move(dragging, i); setDragging(null); }
                },
                    h("img", { src: badge.iconSrc ?? `https://cdn.discordapp.com/badge-icons/${badge.icon}.png`, alt: badge.description ?? "", draggable: false })
                ))
            )
    );
}

function EditorSection({ plugin, headingClass }) {
    const settings = useSettings(plugin);
    const slots = [
        { tab: "decoration", label: "Decoration", value: settings.decoration, img: settings.decoration && decorationUrl(settings.decoration.asset, false) },
        { tab: "effect", label: "Effect", value: settings.effect, img: settings.effect?.thumbnail },
        { tab: "nameplate", label: "Nameplate", value: settings.nameplate, img: settings.nameplate && nameplateUrl(settings.nameplate.asset, false) },
        { tab: "frame", label: "Frame", value: settings.frame },
        { tab: "banner", label: "Banner", value: settings.banner, img: settings.banner?.url },
        { tab: "nameStyle", label: "Name Style", value: settings.nameStyle },
        { tab: "badges", label: "Badges", value: settings.badges.length ? settings.badges : null }
    ];

    return h(React.Fragment, null,
        h("h3", { className: headingClass }, "Nitro Simulator"),
        h("div", { className: "ns-section-note" }, "Only you can see these."),
        h("div", { className: "ns-slots" },
            slots.map(slot => h("button", {
                key: slot.tab,
                className: `ns-slot ${slot.value ? "ns-active" : ""}`,
                onClick: () => plugin.openPicker(slot.tab),
                title: slot.value?.name ?? slot.label
            },
                slot.tab === "badges" && slot.value
                    ? h("div", { className: "ns-slot-badges" }, slot.value.slice(0, 4).map(b => h("img", { key: b.badgeId, src: b.profile.iconSrc, alt: "" })))
                    : slot.tab === "nameStyle" && slot.value
                        ? h("div", { className: "ns-slot-name" }, h(StyledName, { name: "Aa", style: slot.value }))
                        : slot.img ? h("img", { className: slot.tab === "banner" ? "ns-slot-banner" : undefined, src: slot.img, alt: "" }) : null,
                h("span", null, slot.label)
            ))
        )
    );
}

const STYLES = `
.bd-modal-root:has(.ns-picker) { width: min(880px, calc(100vw - 80px)); max-width: none; }
.ns-picker { display: flex; flex-direction: column; gap: 12px; color: var(--text-default, var(--text-normal)); }
.ns-note, .ns-section-note { font-size: 13px; color: var(--text-muted); }
.ns-section-note { margin: -4px 0 8px; }
.ns-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
.ns-tab { padding: 6px 12px; border-radius: 8px; background: var(--background-mod-subtle, var(--background-modifier-hover)); color: var(--interactive-normal); font-size: 14px; font-weight: 500; }
.ns-tab:hover { color: var(--interactive-hover); }
.ns-tab.ns-active { background: var(--brand-500, #5865f2); color: #fff; }
.ns-search { width: 100%; box-sizing: border-box; padding: 8px 10px; margin-bottom: 10px; border-radius: 8px; border: 1px solid var(--border-subtle, transparent); background: var(--input-background, var(--background-tertiary)); color: var(--text-default, var(--text-normal)); font-size: 14px; }
.ns-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px; max-height: 55vh; overflow-y: auto; padding: 2px; }
.ns-grid-nameplate, .ns-grid-frame { grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); }
.ns-tile { display: flex; flex-direction: column; align-items: stretch; gap: 6px; padding: 6px; border-radius: 10px; background: var(--background-mod-subtle, var(--background-secondary)); border: 2px solid transparent; color: inherit; cursor: pointer; text-align: center; }
.ns-tile:hover { background: var(--background-mod-normal, var(--background-modifier-hover)); }
.ns-tile.ns-active { border-color: var(--brand-500, #5865f2); }
.ns-thumb { height: 92px; display: flex; align-items: center; justify-content: center; overflow: hidden; border-radius: 6px; }
.ns-thumb img, .ns-thumb video { max-width: 100%; max-height: 100%; object-fit: contain; }
.ns-grid-nameplate .ns-thumb { height: 48px; }
.ns-grid-nameplate .ns-thumb img, .ns-grid-nameplate .ns-thumb video { width: 100%; height: 100%; object-fit: cover; }
.ns-grid-frame .ns-thumb { height: 120px; }
.ns-label { font-size: 12px; line-height: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ns-none { font-size: 13px; color: var(--text-muted); padding: 0 6px; }
.ns-more { margin-top: 8px; width: 100%; padding: 8px; border-radius: 8px; background: var(--background-mod-subtle, var(--background-secondary)); color: var(--interactive-normal); }
.ns-empty { padding: 16px; text-align: center; color: var(--text-muted); }
.ns-frame { position: relative; width: 110px; height: 100px; }
.ns-frame > :not(.ns-frame-card) { position: absolute; inset: 0; }
.ns-frame-card { position: absolute; inset: 10px 14px; border-radius: 8px; background: var(--background-base-low, var(--background-tertiary)); }
.ns-row { display: flex; align-items: center; gap: 12px; padding: 10px; border-radius: 10px; margin-bottom: 6px; background: var(--background-mod-subtle, var(--background-secondary)); border: 2px solid transparent; }
.ns-row.ns-active { border-color: var(--brand-500, #5865f2); }
.ns-row-head { margin-bottom: 12px; }
.ns-row-text { flex: 1; min-width: 0; }
.ns-row-name { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.ns-row-desc { font-size: 12px; color: var(--text-muted); margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ns-owned { white-space: nowrap; font-size: 11px; font-weight: 500; padding: 1px 6px; border-radius: 6px; background: var(--background-mod-normal, var(--background-modifier-accent)); color: var(--text-muted); }
.ns-badge-icon { width: 32px; height: 32px; object-fit: contain; flex-shrink: 0; }
.ns-tier { width: 210px; flex-shrink: 0; }
.ns-slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px; }
.ns-slot { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; height: 92px; padding: 6px; border-radius: 8px; background: var(--background-mod-subtle, var(--background-secondary)); border: 2px solid transparent; color: var(--interactive-normal); font-size: 12px; font-weight: 500; cursor: pointer; overflow: hidden; }
.ns-slot:hover { background: var(--background-mod-normal, var(--background-modifier-hover)); color: var(--interactive-hover); }
.ns-slot.ns-active { border-color: var(--brand-500, #5865f2); }
.ns-slot > img { max-width: 100%; height: 52px; object-fit: contain; }
.ns-slot > img.ns-slot-banner { width: 100%; object-fit: cover; border-radius: 4px; }
.ns-slot-name { font-size: 22px; height: 52px; display: flex; align-items: center; }
.ns-button { padding: 8px 14px; border-radius: 8px; background: var(--brand-500, #5865f2); color: #fff; font-size: 14px; font-weight: 500; white-space: nowrap; }
.ns-button:disabled { opacity: .5; cursor: not-allowed; }
.ns-button.ns-secondary { background: var(--background-mod-normal, var(--background-modifier-accent)); color: var(--interactive-active, var(--text-normal)); }
.ns-error { color: var(--text-feedback-critical, #f23f43); font-size: 13px; }
.ns-banner { display: flex; flex-direction: column; gap: 10px; }
.ns-banner-preview { aspect-ratio: 5 / 2; border-radius: 10px; overflow: hidden; display: flex; align-items: center; justify-content: center; background: var(--background-mod-subtle, var(--background-secondary)); color: var(--text-muted); }
.ns-banner-preview img { width: 100%; height: 100%; object-fit: cover; }
.ns-banner-row { display: flex; gap: 8px; align-items: center; }
.ns-banner-row .ns-search { margin: 0; flex: 1; }
.ns-namestyle { display: flex; flex-direction: column; gap: 8px; }
.ns-name-preview { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 16px; border-radius: 10px; background: var(--background-mod-subtle, var(--background-secondary)); font-size: 26px; font-weight: 700; }
.ns-heading { margin-top: 6px; font-size: 12px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); }
.ns-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ns-chip { padding: 6px 12px; border-radius: 8px; background: var(--background-mod-subtle, var(--background-secondary)); border: 2px solid transparent; color: var(--interactive-normal); font-size: 15px; }
.ns-chip.ns-active { border-color: var(--brand-500, #5865f2); color: var(--interactive-active, #fff); }
.ns-swatch { width: 44px; height: 28px; border-radius: 8px; border: 2px solid transparent; }
.ns-swatch.ns-active { border-color: #fff; box-shadow: 0 0 0 2px var(--brand-500, #5865f2); }
.ns-color { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-muted); }
.ns-color input { width: 36px; height: 28px; padding: 0; border: none; background: none; cursor: pointer; }
.ns-order { padding: 10px; border-radius: 10px; margin-bottom: 12px; background: var(--background-mod-subtle, var(--background-secondary)); }
.ns-order-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.ns-order-list { display: flex; flex-wrap: wrap; gap: 6px; }
.ns-order-item { width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; border-radius: 8px; background: var(--background-mod-normal, var(--background-tertiary)); cursor: grab; }
.ns-order-item img { width: 24px; height: 24px; object-fit: contain; pointer-events: none; }
.ns-order-item.ns-dragging { opacity: .4; }
.ns-slot-badges { display: flex; gap: 2px; }
.ns-slot-badges img { width: 22px; height: 22px; object-fit: contain; }
`;
