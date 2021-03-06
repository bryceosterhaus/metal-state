'use strict';

import { array, async, core, object } from 'metal';
import { EventEmitter } from 'metal-events';

/**
 * State adds support for having object properties that can be watched for
 * changes, as well as configured with validators, setters and other options.
 * See the `addToState` method for a complete list of available configuration
 * options for each state key.
 * @constructor
 * @extends {EventEmitter}
 */
class State extends EventEmitter {
	constructor(opt_config) {
		super();

		/**
		 * Object with information about the batch event that is currently
		 * scheduled, or null if none is.
		 * @type {Object}
		 * @protected
		 */
		this.scheduledBatchData_ = null;

		/**
		 * Object that contains information about all this instance's state keys.
		 * @type {!Object<string, !Object>}
		 * @protected
		 */
		this.stateInfo_ = {};

		/**
		 * Object with the most recent values that state properties were set to
		 * through either the constructor or setState calls.
		 * @type {!Object<string, *>}
		 */
		this.config = {};

		this.updateConfig_(opt_config || {});
		this.setShouldUseFacade(true);
		this.mergeInvalidKeys_();
		this.addToStateFromStaticHint_(opt_config);
	}

	/**
	 * Adds the given key to the state.
	 * @param {string} name The name of the new state key.
	 * @param {Object.<string, *>=} config The configuration object for the new
	 *     key. See `addToState` for supported settings.
	 * @param {*} initialValue The initial value of the new key.
	 */
	addKeyToState(name, config, initialValue) {
		this.buildKeyInfo_(name, config, initialValue);
		Object.defineProperty(this, name, this.buildKeyPropertyDef_(name));
	}

	/**
	 * Adds the given key(s) to the state, together with its(their) configs.
	 * Config objects support the given settings:
	 *     setter - Function for normalizing state key values. It receives the new
	 *     value that was set, and returns the value that should be stored.
	 *
	 *     validator - Function that validates state key values. When it returns
	 *     false, the new value is ignored.
	 *
	 *     value - The default value for the state key. Note that setting this to
	 *     an object will cause all class instances to use the same reference to
	 *     the object. To have each instance use a different reference for objects,
	 *     use the `valueFn` option instead.
	 *
	 *     valueFn - A function that returns the default value for a state key.
	 *
	 *     writeOnce - Ignores writes to the state key after it's been first
	 *     written to. That is, allows writes only when setting the value for the
	 *     first time.
	 * @param {!Object.<string, !Object>|string} configsOrName An object that maps
	 *     configuration options for keys to be added to the state or the name of
	 *     a single key to be added.
	 * @param {Object.<string, *>=} opt_initialValuesOrConfig An object that maps
	 *     state keys to their initial values. These values have higher precedence
	 *     than the default values specified in the configurations. If a single
	 *     key name was passed as the first param instead though, then this should
	 *     be the configuration object for that key.
	 * @param {boolean|Object|*=} opt_contextOrInitialValue If the first
	 *     param passed to this method was a config object, this should be the
	 *     context where the added state keys will be defined (defaults to `this`),
	 *     or false if they shouldn't be defined at all. If the first param was a
	 *     single key name though, this should be its initial value.
	 */
	addToState(configsOrName, opt_initialValuesOrConfig, opt_contextOrInitialValue) {
		if (core.isString(configsOrName)) {
			return this.addKeyToState(
				configsOrName,
				opt_initialValuesOrConfig,
				opt_contextOrInitialValue
			);
		}

		var initialValues = opt_initialValuesOrConfig || {};
		var names = Object.keys(configsOrName);

		var props = {};
		for (var i = 0; i < names.length; i++) {
			var name = names[i];
			this.buildKeyInfo_(name, configsOrName[name], initialValues[name]);
			props[name] = this.buildKeyPropertyDef_(name);
		}

		if (opt_contextOrInitialValue !== false) {
			Object.defineProperties(opt_contextOrInitialValue || this, props);
		}
	}

	/**
	 * Adds state keys from super classes static hint `MyClass.STATE = {};`.
	 * @param {Object.<string, !Object>=} opt_config An object that maps all the
	 *     configurations for state keys.
	 * @protected
	 */
	addToStateFromStaticHint_(opt_config) {
		var ctor = this.constructor;
		var defineContext = false;
		if (State.mergeStateStatic(ctor)) {
			defineContext = ctor.prototype;
		}
		this.addToState(ctor.STATE_MERGED, opt_config, defineContext);
	}

	/**
	 * Checks that the given name is a valid state key name. If it's not, an error
	 * will be thrown.
	 * @param {string} name The name to be validated.
	 * @throws {Error}
	 * @protected
	 */
	assertValidStateKeyName_(name) {
		if (this.constructor.INVALID_KEYS_MERGED[name]) {
			throw new Error('It\'s not allowed to create a state key with the name "' + name + '".');
		}
	}

	/**
	 * Builds the info object for the specified state key.
	 * @param {string} name The name of the key.
	 * @param {Object} config The config object for the key.
	 * @param {*} initialValue The initial value of the key.
	 * @protected
	 */
	buildKeyInfo_(name, config, initialValue) {
		this.assertValidStateKeyName_(name);

		this.stateInfo_[name] = {
			config: config || {},
			initialValue: initialValue,
			state: State.KeyStates.UNINITIALIZED
		};
	}

	/**
	 * Builds the property definition object for the specified state key.
	 * @param {string} name The name of the key.
	 * @return {!Object}
	 * @protected
	 */
	buildKeyPropertyDef_(name) {
		return {
			configurable: true,
			enumerable: true,
			get: function() {
				return this.getStateKeyValue_(name);
			},
			set: function(val) {
				this.setStateKeyValue_(name, val);
			}
		};
	}

	/**
	 * Calls the requested function, running the appropriate code for when it's
	 * passed as an actual function object or just the function's name.
	 * @param {!Function|string} fn Function, or name of the function to run.
	 * @param {!Array} An optional array of parameters to be passed to the
	 *   function that will be called.
	 * @return {*} The return value of the called function.
	 * @protected
	 */
	callFunction_(fn, args) {
		if (core.isString(fn)) {
			return this[fn].apply(this, args);
		} else if (core.isFunction(fn)) {
			return fn.apply(this, args);
		}
	}

	/**
	 * Calls the state key's setter, if there is one.
	 * @param {string} name The name of the key.
	 * @param {*} value The value to be set.
	 * @param {*} currentValue The current value.
	 * @return {*} The final value to be set.
	 * @protected
	 */
	callSetter_(name, value, currentValue) {
		var info = this.stateInfo_[name];
		var config = info.config;
		if (config.setter) {
			value = this.callFunction_(config.setter, [value, currentValue]);
		}
		return value;
	}

	/**
	 * Calls the state key's validator, if there is one.
	 * @param {string} name The name of the key.
	 * @param {*} value The value to be validated.
	 * @return {boolean} Flag indicating if value is valid or not.
	 * @protected
	 */
	callValidator_(name, value) {
		var info = this.stateInfo_[name];
		var config = info.config;
		if (config.validator) {
			return this.callFunction_(config.validator, [value, name]);
		}
		return true;
	}

	/**
	 * Checks if the it's allowed to write on the requested state key.
	 * @param {string} name The name of the key.
	 * @return {boolean}
	 */
	canSetState(name) {
		var info = this.stateInfo_[name];
		return !info.config.writeOnce || !info.written;
	}

	/**
	 * @inheritDoc
	 */
	disposeInternal() {
		super.disposeInternal();
		this.stateInfo_ = null;
		this.scheduledBatchData_ = null;
	}

	/**
	 * Emits the state change batch event.
	 * @protected
	 */
	emitBatchEvent_() {
		if (!this.isDisposed()) {
			var data = this.scheduledBatchData_;
			this.scheduledBatchData_ = null;
			this.emit('stateChanged', data);
		}
	}

	/**
	 * Returns the value of the requested state key.
	 * Note: this can and should be accomplished by accessing the value as a
	 * regular property. This should only be used in cases where a function is
	 * actually needed.
	 * @param {string} name
	 * @return {*}
	 */
	get(name) {
		return this[name];
	}

	/**
	 * Returns an object that maps state keys to their values.
	 * @param {Array<string>=} opt_names A list of names of the keys that should
	 *   be returned. If none is given, the whole state will be returned.
	 * @return {Object.<string, *>}
	 */
	getState(opt_names) {
		var state = {};
		var names = opt_names || this.getStateKeys();

		for (var i = 0; i < names.length; i++) {
			state[names[i]] = this[names[i]];
		}

		return state;
	}

	/**
	 * Gets the config object for the requested state key.
	 * @param {string} name The key's name.
	 * @return {Object}
	 * @protected
	 */
	getStateKeyConfig(name) {
		return (this.stateInfo_[name] || {}).config;
	}

	/**
	 * Returns an array with all state keys.
	 * @return {Array.<string>}
	 */
	getStateKeys() {
		return Object.keys(this.stateInfo_);
	}

	/**
	 * Gets the value of the specified state key. This is passed as that key's
	 * getter to the `Object.defineProperty` call inside the `addKeyToState` method.
	 * @param {string} name The name of the key.
	 * @return {*}
	 * @protected
	 */
	getStateKeyValue_(name) {
		this.initStateKey_(name);
		return this.stateInfo_[name].value;
	}

	/**
	 * Checks if the value of the state key with the given name has already been
	 * set. Note that this doesn't run the key's getter.
	 * @param {string} name The name of the key.
	 * @return {boolean}
	 */
	hasBeenSet(name) {
		var info = this.stateInfo_[name];
		return info.state === State.KeyStates.INITIALIZED || info.initialValue;
	}

	/**
	 * Informs of changes to a state key's value through an event. Won't trigger
	 * the event if the value hasn't changed or if it's being initialized.
	 * @param {string} name The name of the key.
	 * @param {*} prevVal The previous value of the key.
	 * @protected
	 */
	informChange_(name, prevVal) {
		if (this.shouldInformChange_(name, prevVal)) {
			var data = {
				key: name,
				newVal: this[name],
				prevVal: prevVal
			};
			this.emit(name + 'Changed', data);
			this.emit('stateKeyChanged', data);
			this.scheduleBatchEvent_(data);
		}
	}

	/**
	 * Initializes the specified state key, giving it a first value.
	 * @param {string} name The name of the key.
	 * @protected
	 */
	initStateKey_(name) {
		var info = this.stateInfo_[name];
		if (info.state !== State.KeyStates.UNINITIALIZED) {
			return;
		}

		info.state = State.KeyStates.INITIALIZING;
		this.setInitialValue_(name);
		if (!info.written) {
			info.state = State.KeyStates.INITIALIZING_DEFAULT;
			this.setDefaultValue_(name);
		}
		info.state = State.KeyStates.INITIALIZED;
	}

	/**
	 * Merges an array of values for the STATE property into a single object.
	 * @param {!Array} values The values to be merged.
	 * @return {!Object} The merged value.
	 * @static
	 * @protected
	 */
	static mergeState_(values) {
		return object.mixin.apply(null, [{}].concat(values.reverse()));
	}

	/**
	 * Merges the STATE static variable for the given constructor function.
	 * @param  {!Function} ctor Constructor function.
	 * @return {boolean} Returns true if merge happens, false otherwise.
	 * @static
	 */
	static mergeStateStatic(ctor) {
		return core.mergeSuperClassesProperty(ctor, 'STATE', State.mergeState_);
	}

	/**
	 * Merges the values of the `INVALID_KEYS` static for the whole hierarchy of
	 * the current instance.
	 * @protected
	 */
	mergeInvalidKeys_() {
		core.mergeSuperClassesProperty(this.constructor, 'INVALID_KEYS', function(values) {
			return array.flatten(values).reduce(function(merged, val) {
				if (val) {
					merged[val] = true;
				}
				return merged;
			}, {});
		});
	}

	/**
	 * Removes the requested state key.
	 * @param {string} name The name of the key.
	 */
	removeStateKey(name) {
		this.stateInfo_[name] = null;
		delete this[name];
	}

	/**
	 * Schedules a state change batch event to be emitted asynchronously.
	 * @param {!Object} changeData Information about a state key's update.
	 * @protected
	 */
	scheduleBatchEvent_(changeData) {
		if (!this.scheduledBatchData_) {
			async.nextTick(this.emitBatchEvent_, this);
			this.scheduledBatchData_ = {
				changes: {}
			};
		}

		var name = changeData.key;
		var changes = this.scheduledBatchData_.changes;
		if (changes[name]) {
			changes[name].newVal = changeData.newVal;
		} else {
			changes[name] = changeData;
		}
	}

	/**
	 * Sets the value of the requested state key.
	 * Note: this can and should be accomplished by setting the state key as a
	 * regular property. This should only be used in cases where a function is
	 * actually needed.
	 * @param {string} name
	 * @param {*} value
	 * @return {*}
	 */
	set(name, value) {
		this[name] = value;
	}

	/**
	 * Sets the default value of the requested state key.
	 * @param {string} name The name of the key.
	 * @return {*}
	 * @protected
	 */
	setDefaultValue_(name) {
		var config = this.stateInfo_[name].config;

		if (config.value !== undefined) {
			this[name] = config.value;
		} else {
			this[name] = this.callFunction_(config.valueFn);
		}
	}

	/**
	 * Sets the initial value of the requested state key.
	 * @param {string} name The name of the key.
	 * @return {*}
	 * @protected
	 */
	setInitialValue_(name) {
		var info = this.stateInfo_[name];
		if (info.initialValue !== undefined) {
			this[name] = info.initialValue;
			info.initialValue = undefined;
		}
	}

	/**
	 * Sets the value of all the specified state keys.
	 * @param {!Object.<string,*>} values A map of state keys to the values they
	 *   should be set to.
	 * @param {function()=} opt_callback An optional function that will be run
	 *   after the next batched update is triggered.
	 */
	setState(values, opt_callback) {
		this.updateConfig_(values);
		var names = Object.keys(values);
		for (var i = 0; i < names.length; i++) {
			this[names[i]] = values[names[i]];
		}
		if (opt_callback && this.scheduledBatchData_) {
			this.once('stateChanged', opt_callback);
		}
	}

	/**
	 * Sets the value of the specified state key. This is passed as that key's
	 * setter to the `Object.defineProperty` call inside the `addKeyToState`
	 * method.
	 * @param {string} name The name of the key.
	 * @param {*} value The new value of the key.
	 * @protected
	 */
	setStateKeyValue_(name, value) {
		if (!this.canSetState(name) || !this.validateKeyValue_(name, value)) {
			return;
		}

		var info = this.stateInfo_[name];
		if (info.initialValue === undefined && info.state === State.KeyStates.UNINITIALIZED) {
			info.state = State.KeyStates.INITIALIZED;
		}

		var prevVal = this[name];
		info.value = this.callSetter_(name, value, prevVal);
		info.written = true;
		this.informChange_(name, prevVal);
	}

	/**
	 * Checks if we should inform about a state update. Updates are ignored during
	 * state initialization. Otherwise, updates to primitive values are only
	 * informed when the new value is different from the previous one. Updates to
	 * objects (which includes functions and arrays) are always informed outside
	 * initialization though, since we can't be sure if all of the internal data
	 * has stayed the same.
	 * @param {string} name The name of the key.
	 * @param {*} prevVal The previous value of the key.
	 * @return {boolean}
	 * @protected
	 */
	shouldInformChange_(name, prevVal) {
		var info = this.stateInfo_[name];
		return (info.state === State.KeyStates.INITIALIZED) &&
			(core.isObject(prevVal) || prevVal !== this[name]);
	}

	/**
	 * Updates the config data object with the given values.
	 * @param {!Object} values
	 * @protected
	 */
	updateConfig_(values) {
		var prevConfig = this.config;
		this.config = object.mixin({}, this.config, values);
		this.emit('configChanged', {
			newVal: this.config,
			prevVal: prevConfig
		});
	}

	/**
	 * Validates the state key's value, which includes calling the validator
	 * defined in the key's configuration object, if there is one.
	 * @param {string} name The name of the key.
	 * @param {*} value The value to be validated.
	 * @return {boolean} Flag indicating if value is valid or not.
	 * @protected
	 */
	validateKeyValue_(name, value) {
		var info = this.stateInfo_[name];

		return info.state === State.KeyStates.INITIALIZING_DEFAULT ||
			this.callValidator_(name, value);
	}
}

/**
 * A list with state key names that will automatically be rejected as invalid.
 * Subclasses can define their own invalid keys by setting this static on their
 * constructors, which will be merged together and handled automatically.
 * @type {!Array<string>}
 */
State.INVALID_KEYS = ['config', 'state', 'stateKey'];

/**
 * Constants that represent the states that an a state key can be in.
 * @type {!Object}
 */
State.KeyStates = {
	UNINITIALIZED: 0,
	INITIALIZING: 1,
	INITIALIZING_DEFAULT: 2,
	INITIALIZED: 3
};

export default State;
