extends CanvasLayer
## MetaHarness's tuning panel for a prototype. Ask it for a value wherever the game uses one:
##
##     var shake := MhTune.knob("shake_amount", 0.0, 2.0, 0.5, "Shake amount")
##
## Call it every frame: the value changes as the slider moves. F10 shows or hides the panel, and
## "Keep these values" tells the room. Prototypes only: production has no use for this file.

const TUNING := "res://.prototype/tuning.json"
const KEPT := "res://.prototype/kept.json"
const TOGGLE := KEY_F10

var _values := {}
var _defaults := {}
var _saved := {}
var _sliders := {}
var _save_in := -1.0
var _box: VBoxContainer
var _panel: PanelContainer
var _kept_label: Label
var _mouse_before := Input.MOUSE_MODE_VISIBLE


func _ready() -> void:
	layer = 128
	process_mode = Node.PROCESS_MODE_ALWAYS
	if FileAccess.file_exists(TUNING):
		var read = JSON.parse_string(FileAccess.get_file_as_string(TUNING))
		if read is Dictionary and read.get("values") is Dictionary:
			_saved = read["values"]
	if DisplayServer.get_name() != "headless":
		_build()


## The knob's value. The first call for a name adds its slider; later ones just read it.
func knob(knob_name: String, min_value: float, max_value: float, value: float, label := "", step := 0.0) -> float:
	if _values.has(knob_name):
		return _values[knob_name]
	var start: float = _saved.get(knob_name, value)
	_values[knob_name] = start
	_defaults[knob_name] = value
	if _box != null:
		_add_slider(knob_name, label if label != "" else knob_name, min_value, max_value, start, step)
	return start


## All the values as they are now.
func values() -> Dictionary:
	return _values.duplicate()


## What the Keep button does: the daemon picks this up and puts the values on the board.
func keep() -> void:
	var file := FileAccess.open(KEPT, FileAccess.WRITE)
	if file == null:
		push_error("MhTune couldn't write %s: %s" % [KEPT, error_string(FileAccess.get_open_error())])
		return
	file.store_string(JSON.stringify({"values": _values}))
	file.close()
	if _kept_label != null:
		_kept_label.text = "Kept. It's on the board."


func _save() -> void:
	var file := FileAccess.open(TUNING, FileAccess.WRITE)
	if file != null:
		file.store_string(JSON.stringify({"values": _values}))


func _process(delta: float) -> void:
	if _save_in < 0.0:
		return
	_save_in -= delta
	if _save_in < 0.0:
		_save()


func _unhandled_key_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == TOGGLE:
		_show_panel(not _panel.visible)


func _show_panel(on: bool) -> void:
	if _panel == null:
		return
	if on:
		_mouse_before = Input.mouse_mode
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	else:
		Input.mouse_mode = _mouse_before
	_panel.visible = on


func _build() -> void:
	_panel = PanelContainer.new()
	_panel.set_anchors_and_offsets_preset(Control.PRESET_TOP_RIGHT)
	_panel.offset_left = -340
	_panel.offset_right = -8
	_panel.offset_top = 8
	_panel.grow_horizontal = Control.GROW_DIRECTION_BEGIN
	add_child(_panel)
	var margin := MarginContainer.new()
	for side in ["left", "right", "top", "bottom"]:
		margin.add_theme_constant_override("margin_" + side, 8)
	_panel.add_child(margin)
	var column := VBoxContainer.new()
	margin.add_child(column)
	var head := Label.new()
	head.text = "Tuning (F10 hides this)"
	column.add_child(head)
	_box = VBoxContainer.new()
	column.add_child(_box)
	var buttons := HBoxContainer.new()
	column.add_child(buttons)
	var keep_button := Button.new()
	keep_button.text = "Keep these values"
	keep_button.pressed.connect(keep)
	buttons.add_child(keep_button)
	var reset := Button.new()
	reset.text = "Reset"
	reset.pressed.connect(_reset)
	buttons.add_child(reset)
	_kept_label = Label.new()
	column.add_child(_kept_label)


func _add_slider(knob_name: String, label: String, min_value: float, max_value: float, start: float, step: float) -> void:
	var row := HBoxContainer.new()
	var name_label := Label.new()
	name_label.text = label
	name_label.custom_minimum_size.x = 120
	name_label.clip_text = true
	name_label.tooltip_text = knob_name
	row.add_child(name_label)
	var slider := HSlider.new()
	slider.min_value = min_value
	slider.max_value = max_value
	slider.step = step if step > 0.0 else (max_value - min_value) / 200.0
	slider.value = start
	slider.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	slider.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	row.add_child(slider)
	var value_label := Label.new()
	value_label.custom_minimum_size.x = 56
	value_label.text = "%.3f" % start
	row.add_child(value_label)
	slider.value_changed.connect(func(v: float) -> void:
		_values[knob_name] = v
		value_label.text = "%.3f" % v
		_kept_label.text = ""
		_save_in = 0.3)
	_sliders[knob_name] = slider
	_box.add_child(row)


func _reset() -> void:
	for knob_name in _sliders:
		_sliders[knob_name].value = _defaults[knob_name]
