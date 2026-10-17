window.__ModuleLoader__.load({
	id: "dsh-telegram-app",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		//#region locales
		/** Dictionary namespace owned by this client half. */
		const NS = "telegram-app.config";
		/** English copy. */
		const en = {
			title: "Telegram bridge",
			summary: "Pairing, navigation and notifications over a Telegram chat.",
			intro: "These are the deployment defaults. Choices made on the bot's own settings screen override them per chat.",
			sectionToken: "Bot",
			botToken: "Bot token",
			botTokenHint: "From @BotFather. Stored on the host and never sent back to a browser, so the field stays empty even when a token is set.",
			botTokenSet: "A token is configured — leave blank to keep it.",
			botTokenUnset: "No token yet; the bot stays idle until one is set.",
			sectionControl: "Chat authorization",
			controlToken: "Control token",
			controlTokenHint: "The secret you send the bot once in the chat to authorize it. Hidden here for the same reason as the bot token.",
			controlTokenSet: "A control token is configured — leave blank to keep it.",
			controlTokenUnset: "No control token yet; one is generated on first run.",
			tokenUnknown: "Whether a value is stored could not be read; a blank field leaves whatever is stored untouched.",
			sectionLanguage: "Language",
			locale: "Bot language",
			localeHint: "The language the bot speaks in the chat: ru or en. Command names are never translated, only the copy around them. Takes effect on the next message, without a restart.",
			save: "Save",
			saving: "Saving…",
			saved: "Saved.",
			discard: "Discard",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			unavailable: "This deployment does not expose the plugin's settings, so it cannot be configured here.",
			notWritable: "This deployment stores settings read-only.",
			loading: "Reading settings…"
		};
		/** Russian copy, so the form follows a Russian Web UI. */
		const ru = {
			title: "Мост в Telegram",
			summary: "Привязка, навигация и уведомления в переписке Telegram.",
			intro: "Это значения по умолчанию для всего развёртывания. Выбор, сделанный на экране настроек самого бота, перекрывает их для конкретного чата.",
			sectionToken: "Бот",
			botToken: "Токен бота",
			botTokenHint: "От @BotFather. Хранится на хосте и никогда не возвращается в браузер, поэтому поле остаётся пустым, даже когда токен задан.",
			botTokenSet: "Токен задан — оставьте пустым, чтобы не менять.",
			botTokenUnset: "Токена пока нет; до его появления бот бездействует.",
			sectionControl: "Авторизация чата",
			controlToken: "Контрольный токен",
			controlTokenHint: "Секрет, который вы один раз отправляете боту в чат, чтобы авторизовать его. Скрыт здесь по той же причине, что и токен бота.",
			controlTokenSet: "Контрольный токен задан — оставьте пустым, чтобы не менять.",
			controlTokenUnset: "Контрольного токена пока нет; он будет сгенерирован при первом запуске.",
			tokenUnknown: "Прочитать, задано ли значение, не удалось; пустое поле оставит хранимое значение без изменений.",
			sectionLanguage: "Язык",
			locale: "Язык бота",
			localeHint: "Язык, на котором бот говорит в чате: ru или en. Имена команд не переводятся, только текст вокруг них. Действует со следующего сообщения, без перезапуска.",
			save: "Сохранить",
			saving: "Сохранение…",
			saved: "Сохранено.",
			discard: "Отменить",
			saveFailed: "Развёртывание не приняло эти значения; они оставлены, чтобы вы их исправили.",
			unavailable: "Это развёртывание не отдаёт настройки плагина, поэтому настроить его здесь нельзя.",
			notWritable: "Это развёртывание хранит настройки только для чтения.",
			loading: "Чтение настроек…"
		};
		//#endregion
		//#region styles
		/** Inline style for one settings block, using the theme's own tokens. */
		const blockStyle = {
			display: "flex",
			flexDirection: "column",
			gap: "6px",
			marginBottom: "18px"
		};
		const labelStyle = {
			fontSize: "13px",
			fontWeight: "600",
			color: "var(--dsw-alias-label-primary)"
		};
		const hintStyle = {
			fontSize: "12px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const inputStyle = {
			boxSizing: "border-box",
			width: "100%",
			padding: "8px 10px",
			borderRadius: "8px",
			border: "0.5px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-base, transparent)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: "13px"
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			gap: "10px",
			marginTop: "4px"
		};
		const buttonStyle = {
			padding: "6px 14px",
			borderRadius: "8px",
			border: "0.5px solid var(--dsw-alias-border-l2)",
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: "13px",
			cursor: "pointer"
		};
		const noticeStyle = {
			fontSize: "13px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		//#endregion
		//#region form
		/**
		 * Turn the host section into the two text values the page edits.
		 * @param form - the form the plugins page supplied, when it supplied one.
		 * @returns `{ botToken, controlToken }`, both strings.
		 */
		function sectionOf(form) {
			const value = form?.state?.value;
			const read = (field) => {
				const raw = value && typeof value === "object" ? value[field] : undefined;
				return typeof raw === "string" ? raw : "";
			};
			return { botToken: read("botToken"), controlToken: read("controlToken"), locale: read("locale") };
		}
		/**
		 * Render one labelled text field.
		 * @param options - the field's id, copy, current text, and edit handler.
		 * @returns the block.
		 */
		function field(options) {
			return (0, react_jsx_runtime.jsxs)("div", {
				style: blockStyle,
				children: [
					(0, react_jsx_runtime.jsx)("label", {
						style: labelStyle,
						htmlFor: options.id,
						children: options.label
					}),
					(0, react_jsx_runtime.jsx)("input", {
						id: options.id,
						type: "text",
						style: inputStyle,
						value: options.value,
						disabled: options.disabled,
						spellCheck: false,
						autoComplete: "off",
						onChange: (event) => options.onEdit(event.target.value)
					}),
					(0, react_jsx_runtime.jsx)("span", {
						style: hintStyle,
						children: options.hint
					})
				]
			});
		}
		/**
		 * Which secret fields the host reports as configured.
		 *
		 * `role('secret')` fields are stripped from every value the client receives, so
		 * an empty input is the *only* thing a configured token can look like — the
		 * owner then sees a blank field above a working bot and reasonably concludes
		 * nothing was saved. The host does publish the missing fact, just not where the
		 * form keeps things: `SettingsNamespaceView.secrets` carries `{ path, set }` per
		 * secret slot on the **mirror**, while the page's form snapshot exposes only
		 * `value`/`base`/`user`/`revision`.
		 *
		 * So the mirror is read directly for this one fact.
		 *
		 * @param ctx - the browser plugin context.
		 * @returns a lookup from field name to "the host holds a value here".
		 */
		function configuredSecrets(ctx) {
			const configured = {};
			try {
				const mirror = ctx.configForms.describe().getSnapshot();
				for (const namespace of mirror?.view?.namespaces ?? []) {
					for (const secret of namespace?.secrets ?? []) {
						const path = Array.isArray(secret?.path) ? secret.path : [];
						if (path.length === 1 && typeof path[0] === "string") configured[path[0]] = secret.set === true;
					}
				}
			} catch {
				// A mirror that cannot be read is not worth failing the page over: the
				// hints then fall back to "leave blank to keep", which is true either way.
			}
			return configured;
		}

		/**
		 * Wrap a shared configuration form as the page-owner's `form` shape.
		 *
		 * The Plugins page hands the form in as an owner prop, but only when the
		 * settings mirror lists an entry whose `ns` equals the **row id**
		 * (`formFor(openRow.rowId)`), and the host's own entry ids carry an
		 * `include:` prefix. When that lookup misses, the page passes nothing — so
		 * the component resolves the form itself from the mirror and states what it
		 * found. Rendering a dead end with no explanation is the failure mode this
		 * whole file exists to avoid.
		 *
		 * @param ctx - the browser plugin context.
		 * @returns `{ form, diagnostics, secrets }`: the form, the reason there is none, and which secrets are set.
		 */
		function resolveForm(ctx) {
			const secrets = configuredSecrets(ctx);
			let namespaces = [];
			try {
				const mirror = ctx.configForms.describe().getSnapshot();
				namespaces = (mirror?.view?.namespaces ?? []).map((entry) => String(entry?.ns ?? ""));
			} catch (error) {
				return { form: undefined, diagnostics: `settings mirror unavailable: ${String(error)}`, secrets };
			}
			const match = namespaces.find((value) => value === ROW_ID)
				?? namespaces.find((value) => value.endsWith(`:${ROW_ID}`))
				?? namespaces.find((value) => value.includes(ROW_ID));
			if (match === undefined) {
				return {
					form: undefined,
					diagnostics: `no settings entry matches "${ROW_ID}"; host serves ${namespaces.length}: ${namespaces.join(", ")}`,
					secrets
				};
			}
			try {
				const scope = ctx.configForms.get(match);
				if (!scope || typeof scope.getSnapshot !== "function") {
					return { form: undefined, diagnostics: `settings entry "${match}" exposes no form`, secrets };
				}
				return {
					form: {
						state: scope.getSnapshot(),
						mutate: (ops, revision) => scope.mutate(ops, revision)
					},
					diagnostics: `resolved settings entry "${match}"`,
					secrets
				};
			} catch (error) {
				return { form: undefined, diagnostics: `settings entry "${match}" failed: ${String(error)}`, secrets };
			}
		}

		/**
		 * The plugin's configuration page.
		 *
		 * The Plugins page hands the form in as an owner prop; when it does not
		 * (the entry is not in the settings mirror under the row id) the component
		 * resolves it directly, and only if that also fails does it say why.
		 *
		 * @param props - the view asked for, the locale reader, and the host form.
		 * @returns the row's one-liner, or the settings form.
		 */
		function TelegramAppView(props) {
			const t = props.t;
			const resolved = props.form === undefined || props.form === null ? props.resolveForm() : { form: props.form, diagnostics: "" };
			const form = resolved.form;
			const initial = sectionOf(form);
			const [draft, setDraft] = (0, react.useState)(initial);
			const [touched, setTouched] = (0, react.useState)({ botToken: false, controlToken: false, locale: false });
			const [saving, setSaving] = (0, react.useState)(false);
			const [failed, setFailed] = (0, react.useState)(false);
			const [saved, setSaved] = (0, react.useState)(false);
			// Host acceptance can land while the reader looks at the page; re-seed
			// the fields that nobody has typed into, so a save elsewhere shows up.
			const revision = form?.state?.revision;
			(0, react.useEffect)(() => {
				const next = sectionOf(form);
				setDraft((previous) => ({
					botToken: touched.botToken ? previous.botToken : next.botToken,
					controlToken: touched.controlToken ? previous.controlToken : next.controlToken,
					locale: touched.locale ? previous.locale : next.locale
				}));
			}, [revision]);
			if (props.view === "summary") return t("summary");
			if (form === undefined || form === null) {
				// The reason is printed rather than swallowed: a settings page that
				// simply cannot be configured is indistinguishable from a broken
				// plugin, and the difference is exactly what a reader needs.
				return (0, react_jsx_runtime.jsx)("p", {
					style: noticeStyle,
					"data-telegram-config-diagnostic": true,
					children: `${t("unavailable")} (${resolved.diagnostics})`
				});
			}

			const state = form.state;
			const status = state?.status;
			if (status === "loading") return (0, react_jsx_runtime.jsx)("p", { style: noticeStyle, children: t("loading") });
			if (status === "unavailable") return (0, react_jsx_runtime.jsx)("p", { style: noticeStyle, children: t("unavailable") });

			const writable = state?.writable === true;
			const dirty = touched.botToken || touched.controlToken || touched.locale;
			const edit = (field, text) => {
				setDraft((previous) => ({ ...previous, [field]: text }));
				setTouched((previous) => ({ ...previous, [field]: true }));
				setFailed(false);
				setSaved(false);
			};
			const save = async () => {
				const ops = [];
				if (touched.botToken) ops.push({ op: "set", path: ["botToken"], value: draft.botToken });
				if (touched.controlToken) ops.push({ op: "set", path: ["controlToken"], value: draft.controlToken });
				if (touched.locale) ops.push({ op: "set", path: ["locale"], value: draft.locale });
				if (ops.length === 0) return;
				setSaving(true);
				let accepted = false;
				try {
					accepted = await form.mutate(ops, state?.revision);
				} catch {
					accepted = false;
				}
				setSaving(false);
				if (accepted) {
					setTouched({ botToken: false, controlToken: false, locale: false });
					setFailed(false);
					setSaved(true);
				} else {
					setFailed(true);
				}
			};
			const discard = () => {
				setDraft(sectionOf(form));
				setTouched({ botToken: false, controlToken: false, locale: false });
				setFailed(false);
				setSaved(false);
			};
			// Which secrets the host holds. `sectionOf` cannot answer this: the values are
			// stripped from everything the client receives, so the field is empty whether
			// or not a token is stored. Without this, a blank input above a working bot
			// reads as "nothing was saved".
			const secrets = resolved.secrets ?? {};
			const secretHint = (field, setText, unsetText) => {
				const known = Object.hasOwn(secrets, field);
				if (known && secrets[field]) return setText;
				if (known) return unsetText;
				// The mirror did not report this slot, so the state is genuinely unknown;
				// the neutral wording is the only honest one.
				return t("tokenUnknown");
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				children: [
					(0, react_jsx_runtime.jsx)("p", { style: hintStyle, children: t("intro") }),
					field({
						id: "dsh-telegram-app-bot-token",
						label: t("botToken"),
						hint: `${t("botTokenHint")} ${secretHint("botToken", t("botTokenSet"), t("botTokenUnset"))}`,
						value: draft.botToken,
						disabled: !writable,
						onEdit: (text) => edit("botToken", text)
					}),
					field({
						id: "dsh-telegram-app-control-token",
						label: t("controlToken"),
						hint: `${t("controlTokenHint")} ${secretHint("controlToken", t("controlTokenSet"), t("controlTokenUnset"))}`,
						value: draft.controlToken,
						disabled: !writable,
						onEdit: (text) => edit("controlToken", text)
					}),
					field({
						id: "dsh-telegram-app-locale",
						label: t("locale"),
						hint: t("localeHint"),
						value: draft.locale,
						disabled: !writable,
						onEdit: (text) => edit("locale", text)
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
						children: [
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle,
								disabled: !writable || !dirty || saving,
								onClick: () => void save(),
								children: saving ? t("saving") : t("save")
							}),
							dirty ? (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle,
								disabled: saving,
								onClick: discard,
								children: t("discard")
							}) : null,
							saved ? (0, react_jsx_runtime.jsx)("span", { style: hintStyle, children: t("saved") }) : null
						]
					}),
					failed ? (0, react_jsx_runtime.jsx)("p", { style: noticeStyle, children: t("saveFailed") }) : null,
					writable ? null : (0, react_jsx_runtime.jsx)("p", { style: noticeStyle, children: t("notWritable") })
				]
			});
		}
		//#endregion
		//#region mount
		/** The bundle name this client half belongs to. */
		const BUNDLE = "dsh-telegram-app";
		/** The row id as the bundle's patch declares it. */
		const ROW_ID = "telegram-app";
		/** Required services (cordis fiber inject). */
		const inject = ["slots", "locale", "configForms"];
		/**
		 * Mount the plugin's configuration page into the Plugins page.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { en, ru }), `${BUNDLE}: dictionaries`);
			ctx.effect(() => ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
				name: "plugins.row.config",
				key: `${BUNDLE}#${ROW_ID}`,
				label: () => t("title"),
				locale: NS,
				inject: () => ({ resolveForm: () => resolveForm(ctx) })
			}, TelegramAppView)), `${BUNDLE}: row configuration page`);
		}
		//#endregion
		exports.NS = NS;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
