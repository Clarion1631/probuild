import React, { useState, useEffect } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, Modal, FlatList } from 'react-native'

interface CustomTimePickerProps {
    visible: boolean
    initialDate?: Date
    onConfirm: (date: Date) => void
    onCancel: () => void
}

export default function CustomTimePicker({ visible, initialDate, onConfirm, onCancel }: CustomTimePickerProps) {
    const [selectedHour, setSelectedHour] = useState(12)
    const [selectedMinute, setSelectedMinute] = useState(0)
    const [selectedAmPm, setSelectedAmPm] = useState<'AM' | 'PM'>('AM')

    useEffect(() => {
        if (initialDate) {
            let h = initialDate.getHours()
            const m = initialDate.getMinutes()
            const ampm = h >= 12 ? 'PM' : 'AM'

            h = h % 12
            h = h ? h : 12 // the hour '0' should be '12'

            setSelectedHour(h)
            setSelectedMinute(m)
            setSelectedAmPm(ampm)
        }
    }, [initialDate, visible])

    const handleConfirm = () => {
        const now = new Date()
        const date = initialDate ? new Date(initialDate) : new Date()

        // Convert 12h back to 24h
        let h = selectedHour
        if (selectedAmPm === 'PM' && h !== 12) h += 12
        if (selectedAmPm === 'AM' && h === 12) h = 0

        date.setHours(h)
        date.setMinutes(selectedMinute)
        date.setSeconds(0) // reset seconds for cleaner data

        onConfirm(date)
    }

    const hours = Array.from({ length: 12 }, (_, i) => i + 1)
    const minutes = Array.from({ length: 60 }, (_, i) => i)
    const ampms = ['AM', 'PM']

    return (
        <Modal
            visible={visible}
            transparent={true}
            animationType="fade"
            onRequestClose={onCancel}
        >
            <View style={styles.overlay}>
                <View style={styles.container}>
                    <Text style={styles.title}>Select Time</Text>

                    <View style={styles.pickerRow}>
                        {/* Hours */}
                        <View style={styles.column}>
                            <Text style={styles.columnHeader}>Hour</Text>
                            <FlatList
                                data={hours}
                                keyExtractor={item => item.toString()}
                                style={styles.list}
                                showsVerticalScrollIndicator={false}
                                renderItem={({ item }) => (
                                    <TouchableOpacity
                                        style={[styles.item, selectedHour === item && styles.selectedItem]}
                                        onPress={() => setSelectedHour(item)}
                                    >
                                        <Text style={[styles.itemText, selectedHour === item && styles.selectedItemText]}>
                                            {item}
                                        </Text>
                                    </TouchableOpacity>
                                )}
                            // Initial scroll would be nice but simple flatlist is safer for first pass
                            />
                        </View>

                        {/* Minutes */}
                        <View style={styles.column}>
                            <Text style={styles.columnHeader}>Minute</Text>
                            <FlatList
                                data={minutes}
                                keyExtractor={item => item.toString()}
                                style={styles.list}
                                showsVerticalScrollIndicator={false}
                                renderItem={({ item }) => (
                                    <TouchableOpacity
                                        style={[styles.item, selectedMinute === item && styles.selectedItem]}
                                        onPress={() => setSelectedMinute(item)}
                                    >
                                        <Text style={[styles.itemText, selectedMinute === item && styles.selectedItemText]}>
                                            {item.toString().padStart(2, '0')}
                                        </Text>
                                    </TouchableOpacity>
                                )}
                            />
                        </View>

                        {/* AM/PM */}
                        <View style={styles.column}>
                            <Text style={styles.columnHeader}>&nbsp;</Text>
                            <View style={{ gap: 10 }}>
                                {ampms.map(item => (
                                    <TouchableOpacity
                                        key={item}
                                        style={[styles.item, selectedAmPm === item && styles.selectedItem]}
                                        onPress={() => setSelectedAmPm(item as 'AM' | 'PM')}
                                    >
                                        <Text style={[styles.itemText, selectedAmPm === item && styles.selectedItemText]}>
                                            {item}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        </View>
                    </View>

                    <View style={styles.footer}>
                        <TouchableOpacity style={styles.buttonCancel} onPress={onCancel}>
                            <Text style={styles.buttonTextCancel}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.buttonConfirm} onPress={handleConfirm}>
                            <Text style={styles.buttonTextConfirm}>Set Time</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    )
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.6)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20
    },
    container: {
        backgroundColor: 'white',
        borderRadius: 16,
        padding: 20,
        width: '100%',
        maxWidth: 350,
        maxHeight: '70%',
        elevation: 10
    },
    title: {
        fontSize: 18,
        fontWeight: 'bold',
        textAlign: 'center',
        marginBottom: 20,
        color: '#1f2937'
    },
    pickerRow: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        height: 300,
        marginBottom: 20
    },
    column: {
        flex: 1,
        alignItems: 'center'
    },
    columnHeader: {
        fontSize: 12,
        color: '#6b7280',
        marginBottom: 8,
        fontWeight: '600',
        textTransform: 'uppercase'
    },
    list: {
        width: '100%'
    },
    item: {
        paddingVertical: 12,
        alignItems: 'center',
        borderRadius: 8,
        marginBottom: 4
    },
    selectedItem: {
        backgroundColor: '#dbeafe'
    },
    itemText: {
        fontSize: 18,
        color: '#374151'
    },
    selectedItemText: {
        color: '#2563eb',
        fontWeight: 'bold'
    },
    footer: {
        flexDirection: 'row',
        gap: 12
    },
    buttonCancel: {
        flex: 1,
        padding: 14,
        borderRadius: 8,
        backgroundColor: '#f3f4f6',
        alignItems: 'center'
    },
    buttonConfirm: {
        flex: 1,
        padding: 14,
        borderRadius: 8,
        backgroundColor: '#2563eb',
        alignItems: 'center'
    },
    buttonTextCancel: {
        fontWeight: '600',
        color: '#374151'
    },
    buttonTextConfirm: {
        fontWeight: '600',
        color: 'white'
    }
})
