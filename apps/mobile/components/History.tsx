import React, { useState, useEffect } from 'react'
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, Modal, TextInput, ActivityIndicator } from 'react-native'
import { supabase } from '../lib/supabase'
import CustomTimePicker from './CustomTimePicker'

type TimeEntry = {
    id: string
    start_time: string
    end_time: string | null
    duration_minutes: number | null
    jobs: { name: string }
    job_phases?: { name: string; cost_code: string }
}

export default function History({ session }: { session: any }) {
    const [entries, setEntries] = useState<TimeEntry[]>([])
    const [loading, setLoading] = useState(false)
    const [weeklyTotal, setWeeklyTotal] = useState(0)
    const [dailyTotal, setDailyTotal] = useState(0)

    // State for Custom Picker
    const [pickerVisible, setPickerVisible] = useState(false)
    const [pickerMode, setPickerMode] = useState<'start' | 'end'>('start')
    const [tempDate, setTempDate] = useState<Date>(new Date())

    // Edit State with Note
    const [modalVisible, setModalVisible] = useState(false)
    const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null)
    const [editStartStr, setEditStartStr] = useState('')
    const [editEndStr, setEditEndStr] = useState('')
    const [editNote, setEditNote] = useState('')

    useEffect(() => {
        fetchHistory()
    }, [])

    async function fetchHistory() {
        setLoading(true)
        // Get start of week (Sunday)
        const now = new Date()
        const startOfWeek = new Date(now)
        startOfWeek.setDate(now.getDate() - now.getDay())
        startOfWeek.setHours(0, 0, 0, 0)

        const { data, error } = await supabase
            .from('time_entries')
            .select(`
                *,
                jobs ( name ),
                job_phases ( name, cost_code )
            `)
            .eq('user_id', session.user.id)
            .gte('start_time', startOfWeek.toISOString())
            .order('start_time', { ascending: false })

        if (error) {
            Alert.alert('Error', error.message)
        } else if (data) {
            setEntries(data)
            calculateTotals(data)
        }
        setLoading(false)
    }

    function calculateTotals(data: TimeEntry[]) {
        let weekMs = 0
        let todayMs = 0
        const now = new Date()
        const todayStr = now.toDateString()

        data.forEach(entry => {
            const startStr = new Date(entry.start_time).toDateString()
            let duration = 0

            if (entry.end_time) {
                duration = new Date(entry.end_time).getTime() - new Date(entry.start_time).getTime()
            } else {
                // Count current active duration for totals
                duration = new Date().getTime() - new Date(entry.start_time).getTime()
            }

            weekMs += duration
            if (startStr === todayStr) {
                todayMs += duration
            }
        })
        setWeeklyTotal(weekMs / (1000 * 60 * 60)) // Hours
        setDailyTotal(todayMs / (1000 * 60 * 60)) // Hours
    }

    const formatTime = (isoString: string) => {
        return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    const formatDate = (isoString: string) => {
        return new Date(isoString).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    }

    const renderItem = ({ item }: { item: TimeEntry }) => {
        const isToday = new Date(item.start_time).toDateString() === new Date().toDateString()
        const duration = item.end_time
            ? ((new Date(item.end_time).getTime() - new Date(item.start_time).getTime()) / (1000 * 60 * 60)).toFixed(2)
            : 'Active'

        return (
            <View style={styles.entryCard}>
                <View style={styles.entryHeader}>
                    <Text style={styles.date}>{formatDate(item.start_time)}</Text>
                    <Text style={styles.hours}>{duration} hrs</Text>
                </View>
                <View style={styles.entryDetails}>
                    <Text style={styles.jobName}>{item.jobs?.name || 'Unknown Job'}</Text>
                    {item.job_phases && (
                        <Text style={styles.phaseName}>{item.job_phases.cost_code} - {item.job_phases.name}</Text>
                    )}
                </View>
                <View style={styles.timeRange}>
                    <Text style={styles.timeText}>
                        {formatTime(item.start_time)} - {item.end_time ? formatTime(item.end_time) : 'Now'}
                    </Text>
                    {isToday && (
                        <TouchableOpacity onPress={() => handleEdit(item)}>
                            <Text style={styles.editLink}>Edit</Text>
                        </TouchableOpacity>
                    )}
                </View>
            </View>
        )
    }

    const handleEdit = (entry: TimeEntry) => {
        const isToday = new Date(entry.start_time).toDateString() === new Date().toDateString()
        if (!isToday) {
            Alert.alert('Restricted', 'You can only edit entries from today.')
            return
        }
        setEditingEntry(entry)

        // Format for display
        setEditStartStr(formatTime(entry.start_time))
        setEditEndStr(entry.end_time ? formatTime(entry.end_time) : 'Active')

        setEditNote('') // Reset note
        setModalVisible(true)
    }

    const openTimePicker = (mode: 'start' | 'end') => {
        if (!editingEntry) return
        setPickerMode(mode)

        // Determine initial time for picker
        let initial = new Date()
        if (mode === 'start') {
            initial = new Date(editingEntry.start_time)
        } else {
            initial = editingEntry.end_time ? new Date(editingEntry.end_time) : new Date()
        }

        setTempDate(initial)
        setPickerVisible(true)
    }

    const handleTimeConfirm = (date: Date) => {
        if (!editingEntry) return

        if (pickerMode === 'start') {
            // Update local editing entry state so we can save it later? 
            // Better: Just update the display string and a temporary holding value
            // But we need the FULL date object for saving.
            // Let's modify editingEntry directly in state? No, avoid mutating if possible.
            // Let's keep a separate "pending changes" object?
            // Simplest: Edit `editingEntry.start_time` in place in local state copy.

            const UpdatedEntry = { ...editingEntry, start_time: date.toISOString() }
            setEditingEntry(UpdatedEntry)
            setEditStartStr(formatTime(date.toISOString()))
        } else {
            const UpdatedEntry = { ...editingEntry, end_time: date.toISOString() }
            setEditingEntry(UpdatedEntry)
            setEditEndStr(formatTime(date.toISOString()))
        }
        setPickerVisible(false)
    }

    const saveEdit = async () => {
        if (!editingEntry) return

        if (!editNote.trim()) {
            Alert.alert('Requirement', 'Please provide a note explaining this change.')
            return
        }

        try {
            const start = new Date(editingEntry.start_time)
            const end = editingEntry.end_time ? new Date(editingEntry.end_time) : null

            if (end && end < start) {
                Alert.alert('Error', 'End time cannot be before start time.')
                return
            }

            setLoading(true)
            const { error } = await supabase
                .from('time_entries')
                .update({
                    start_time: start.toISOString(),
                    end_time: end ? end.toISOString() : null,
                    notes: editNote // Saving note!
                })
                .eq('id', editingEntry.id)

            if (error) throw error

            setModalVisible(false)
            setEditingEntry(null)
            fetchHistory() // Refresh
            Alert.alert('Success', 'Entry updated')

        } catch (err: any) {
            Alert.alert('Error', err.message)
        } finally {
            setLoading(false)
        }
    }

    const handleDelete = () => {
        if (!editingEntry) return

        Alert.alert(
            'Delete Entry',
            'Are you sure you want to delete this time entry? This cannot be undone.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: async () => {
                        setLoading(true)
                        try {
                            const { error } = await supabase
                                .from('time_entries')
                                .delete()
                                .eq('id', editingEntry.id)

                            if (error) throw error

                            setModalVisible(false)
                            setEditingEntry(null)
                            fetchHistory()
                            Alert.alert('Success', 'Entry deleted')
                        } catch (err: any) {
                            Alert.alert('Error', err.message)
                        } finally {
                            setLoading(false)
                        }
                    }
                }
            ]
        )
    }

    const overtime = Math.max(0, weeklyTotal - 40)
    const regular = Math.min(weeklyTotal, 40)

    return (
        <View style={styles.container}>
            <View style={styles.summaryCard}>
                <Text style={styles.summaryTitle}>Weekly Summary</Text>
                <View style={styles.summaryRow}>
                    <View style={styles.summaryItem}>
                        <Text style={styles.summaryLabel}>Today</Text>
                        <Text style={styles.summaryValue}>{dailyTotal.toFixed(2)}h</Text>
                    </View>
                    <View style={styles.summaryItem}>
                        <Text style={styles.summaryLabel}>Regular</Text>
                        <Text style={styles.summaryValue}>{regular.toFixed(2)}h</Text>
                    </View>
                    <View style={styles.summaryItem}>
                        <Text style={styles.summaryLabel}>Overtime</Text>
                        <Text style={[styles.summaryValue, overtime > 0 && styles.overtimeText]}>
                            {overtime.toFixed(2)}h
                        </Text>
                    </View>
                </View>
            </View>

            <Text style={styles.sectionHeader}>Entries (This Week)</Text>
            <FlatList
                data={entries}
                renderItem={renderItem}
                keyExtractor={item => item.id}
                refreshing={loading}
                onRefresh={fetchHistory}
                contentContainerStyle={{ paddingBottom: 20 }}
            />

            {/* Edit Modal */}
            <Modal
                animationType="slide"
                transparent={true}
                visible={modalVisible}
                onRequestClose={() => setModalVisible(false)}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.modalView}>
                        <Text style={styles.modalTitle}>Edit Entry</Text>
                        <Text style={styles.jobNameSmall}>{editingEntry?.jobs?.name}</Text>

                        {/* Times */}
                        <View style={styles.row}>
                            <View style={styles.inputGroupHalf}>
                                <Text style={styles.label}>Start Time</Text>
                                <TouchableOpacity
                                    style={styles.timeButton}
                                    onPress={() => openTimePicker('start')}
                                >
                                    <Text style={styles.timeButtonText}>{editStartStr}</Text>
                                </TouchableOpacity>
                            </View>
                            <View style={styles.inputGroupHalf}>
                                <Text style={styles.label}>End Time</Text>
                                <TouchableOpacity
                                    style={styles.timeButton}
                                    onPress={() => openTimePicker('end')}
                                >
                                    <Text style={styles.timeButtonText}>{editEndStr}</Text>
                                </TouchableOpacity>
                            </View>
                        </View>

                        {/* Note Field */}
                        <View style={styles.inputGroup}>
                            <Text style={styles.label}>Reason for Change (Required)</Text>
                            <TextInput
                                style={[styles.input, styles.textArea]}
                                value={editNote}
                                onChangeText={setEditNote}
                                placeholder="Forgot to clock out..."
                                multiline
                                numberOfLines={3}
                                textAlignVertical="top"
                            />
                        </View>

                        <View style={styles.modalButtons}>
                            <TouchableOpacity
                                style={[styles.button, styles.buttonCancel]}
                                onPress={() => setModalVisible(false)}
                            >
                                <Text style={styles.buttonTextSmall}>Cancel</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.button, styles.buttonSave]}
                                onPress={saveEdit}
                                disabled={loading}
                            >
                                {loading ? <ActivityIndicator color="white" /> : <Text style={styles.buttonTextSmall}>Save</Text>}
                            </TouchableOpacity>
                        </View>

                        {/* Delete Button */}
                        <TouchableOpacity
                            style={styles.deleteButton}
                            onPress={handleDelete}
                            disabled={loading}
                        >
                            <Text style={styles.deleteButtonText}>Delete Entry</Text>
                        </TouchableOpacity>

                    </View>
                </View>
            </Modal>

            <CustomTimePicker
                visible={pickerVisible}
                initialDate={tempDate}
                onConfirm={handleTimeConfirm}
                onCancel={() => setPickerVisible(false)}
            />
        </View>
    )
}
{/* ... Summary and List View same ... */ }





const styles = StyleSheet.create({
    container: {
        flex: 1,
        width: '100%',
        paddingTop: 10
    },
    summaryCard: {
        backgroundColor: 'white',
        padding: 15,
        borderRadius: 12,
        marginBottom: 20,
        elevation: 2
    },
    summaryTitle: {
        fontSize: 16,
        fontWeight: 'bold',
        marginBottom: 10,
        color: '#374151'
    },
    summaryRow: {
        flexDirection: 'row',
        justifyContent: 'space-between'
    },
    summaryItem: {
        alignItems: 'center',
        flex: 1
    },
    summaryLabel: {
        fontSize: 12,
        color: '#6b7280',
        marginBottom: 4
    },
    summaryValue: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#1f2937'
    },
    overtimeText: {
        color: '#dc2626'
    },
    sectionHeader: {
        fontSize: 18,
        fontWeight: 'bold',
        marginBottom: 10,
        color: '#111827'
    },
    entryCard: {
        backgroundColor: 'white',
        padding: 15,
        borderRadius: 10,
        marginBottom: 10,
        borderLeftWidth: 4,
        borderLeftColor: '#3b82f6',
        elevation: 1
    },
    entryHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 5
    },
    date: {
        fontWeight: 'bold',
        color: '#374151'
    },
    hours: {
        fontWeight: 'bold',
        color: '#1f2937'
    },
    entryDetails: {
        marginBottom: 5
    },
    jobName: {
        fontSize: 16,
        color: '#111827'
    },
    phaseName: {
        fontSize: 14,
        color: '#6b7280'
    },
    timeRange: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 5
    },
    timeText: {
        color: '#9ca3af',
        fontSize: 12
    },
    editLink: {
        color: '#2563eb',
        fontWeight: 'bold',
        fontSize: 12
    },
    // Modal Styles
    modalOverlay: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'rgba(0,0,0,0.5)'
    },
    modalView: {
        width: '90%',
        backgroundColor: 'white',
        borderRadius: 20,
        padding: 20,
        alignItems: 'stretch',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 5
    },
    modalTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        marginBottom: 5,
        textAlign: 'center'
    },
    jobNameSmall: {
        textAlign: 'center',
        marginBottom: 20,
        color: '#6b7280',
        fontStyle: 'italic'
    },
    row: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 10
    },
    inputGroup: {
        marginBottom: 15
    },
    inputGroupHalf: {
        marginBottom: 15,
        flex: 1
    },
    label: {
        marginBottom: 5,
        fontWeight: '600',
        color: '#374151',
        fontSize: 14
    },
    input: {
        borderWidth: 1,
        borderColor: '#d1d5db',
        borderRadius: 8,
        padding: 12,
        fontSize: 16
    },
    textArea: {
        minHeight: 80
    },
    timeButton: {
        borderWidth: 1,
        borderColor: '#d1d5db',
        borderRadius: 8,
        padding: 12,
        alignItems: 'center',
        backgroundColor: '#f9fafb'
    },
    timeButtonText: {
        fontSize: 16,
        fontWeight: '500',
        color: '#111827'
    },
    modalButtons: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 10,
        gap: 10
    },
    button: {
        borderRadius: 8,
        padding: 12,
        elevation: 2,
        width: '45%',
        alignItems: 'center',
        flex: 1
    },
    buttonCancel: {
        backgroundColor: '#9ca3af'
    },
    buttonSave: {
        backgroundColor: '#2563eb'
    },
    buttonTextSmall: {
        color: 'white',
        fontWeight: 'bold'
    },
    deleteButton: {
        marginTop: 20,
        padding: 15,
        backgroundColor: '#fee2e2',
        borderRadius: 8,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: '#fecaca'
    },
    deleteButtonText: {
        color: '#dc2626',
        fontWeight: 'bold',
        fontSize: 16
    }
})
